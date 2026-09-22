// Per-company feed: real news (Google News, 1-year window), real corporate
// actions (Yahoo dividends/splits + exchange CA disclosures), announcements
// (our accumulating NSE store), heuristic risk flags computed from REAL price
// and disclosure data, and an AI desk note (Groq, cached 24h, stats fallback).
//
// Design goal per user requirement: NO company page is ever empty - every
// section always has real content or an honest dated explanation.
// All SQL lives in the repositories.

import { latestFilings, type FilingOut } from './filings-nse'
import { scoreSentiment } from './news-rss'
import { complete, llmAvailable, routeFor } from './llm'
import { getInstrument } from './repositories/instruments'
import { closesAsc } from './repositories/prices'
import * as deskNotesRepo from './repositories/deskNotes'
import * as newsRepo from './repositories/news'
import { makeRssParser } from './util/shared'

const parser = makeRssParser(15_000)

// --- Real per-company news: Google News RSS, 1-year window ---

export interface CompanyNewsItem {
  id: string
  headline: string
  source: string
  publishedAt: string
  sentiment: 'positive' | 'negative' | 'neutral'
  sentimentScore: number
  link?: string
}

const newsCache = new Map<string, { items: CompanyNewsItem[]; at: number }>()
const NEWS_CACHE_MS = 30 * 60 * 1000

export async function companyNews(name: string, symbol?: string): Promise<CompanyNewsItem[]> {
  const hit = newsCache.get(name)
  if (hit && Date.now() - hit.at < NEWS_CACHE_MS) return hit.items
  try {
    const q = encodeURIComponent(`"${name.replace(/\b(ltd\.?|limited)\b/gi, '').trim()}" when:1y`)
    const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`)
    const items: CompanyNewsItem[] = (feed.items ?? []).slice(0, 60).map((it) => {
      // Google News titles end with " - Publisher"
      const raw = (it.title ?? '').trim()
      const m = raw.match(/^(.*)\s-\s([^-]+)$/)
      const headline = (m?.[1] ?? raw).trim()
      const source = (m?.[2] ?? 'Google News').trim()
      const { sentiment, score } = scoreSentiment(headline)
      return {
        // Stable id from the article's own guid/link (or headline) - no positional index.
        id: `gn-${(it.guid ?? it.link ?? headline).toString().replace(/[^a-zA-Z0-9]/g, '').slice(-32)}`,
        headline,
        source,
        publishedAt: it.isoDate ?? new Date().toISOString(),
        sentiment,
        sentimentScore: score,
        link: it.link ?? undefined,
      }
    })
    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    if (items.length) newsCache.set(name, { items, at: Date.now() })
    // Persist into the durable news store (tagged to this symbol) so per-company news
    // ACCUMULATES across sessions — coverage compounds and we re-fetch less.
    if (symbol && items.length) {
      const seenAt = new Date().toISOString()
      newsRepo
        .upsertMany(
          items.map((it) => ({
            dedupKey: it.id,
            headline: it.headline,
            source: it.source,
            publishedAt: it.publishedAt,
            tickers: [symbol.toUpperCase()],
            sentiment: it.sentiment,
            sentimentScore: it.sentimentScore,
            tier: 'press',
            summary: null,
            link: it.link ?? null,
            firstSeenAt: seenAt,
          })),
        )
        .catch(() => {})
    }
    return items
  } catch {
    return hit?.items ?? []
  }
}

// --- Real corporate actions: Yahoo dividends/splits + exchange CA disclosures ---

export interface CorporateAction {
  type: string
  date: string
  detail: string
  source: string
  link?: string
}

const caCache = new Map<string, { items: CorporateAction[]; at: number }>()
const CA_CACHE_MS = 6 * 60 * 60 * 1000

export async function corporateActions(symbol: string, filings: FilingOut[]): Promise<CorporateAction[]> {
  const hit = caCache.get(symbol)
  const fromFilings = filings
    .filter((f) => f.category === 'Corporate Action')
    .map((f) => ({
      type: 'Exchange disclosure',
      date: f.filedAt.slice(0, 10),
      detail: f.aiSummary ?? f.title.slice(0, 180),
      source: 'NSE',
      link: f.link,
    }))
  if (hit && Date.now() - hit.at < CA_CACHE_MS) return [...fromFilings, ...hit.items].slice(0, 25)

  const yahoo: CorporateAction[] = []
  let fetched = false // M-B2: only cache on a successful response, never a transient failure
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?interval=1d&range=5y&events=div%2Csplit`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) },
    )
    if (res.ok) {
      fetched = true
      const data = (await res.json()) as {
        chart?: { result?: { events?: { dividends?: Record<string, { amount: number; date: number }>; splits?: Record<string, { date: number; splitRatio: string }> } }[] }
      }
      const ev = data.chart?.result?.[0]?.events
      for (const d of Object.values(ev?.dividends ?? {})) {
        yahoo.push({
          type: 'Dividend',
          date: new Date(d.date * 1000).toISOString().slice(0, 10),
          detail: `Dividend of ₹${d.amount} per share (ex-date)`,
          source: 'Yahoo Finance',
        })
      }
      for (const s of Object.values(ev?.splits ?? {})) {
        yahoo.push({
          type: 'Split',
          date: new Date(s.date * 1000).toISOString().slice(0, 10),
          detail: `Stock split ${s.splitRatio}`,
          source: 'Yahoo Finance',
        })
      }
    }
  } catch {
    /* yahoo optional */
  }
  yahoo.sort((a, b) => b.date.localeCompare(a.date))
  // M-B2: cache only when Yahoo actually answered — caching [] on a transient failure
  // would blank dividends/splits for the full 6h TTL. On failure, reuse any prior cache.
  if (fetched) caCache.set(symbol, { items: yahoo, at: Date.now() })
  const actions = fetched ? yahoo : hit?.items ?? []
  return [...fromFilings, ...actions].slice(0, 25)
}

// --- Heuristic risk flags from REAL price + disclosure data (never empty) ---

export interface RiskFlag {
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  signal: string
}

async function riskFlags(symbol: string, filings: FilingOut[]): Promise<RiskFlag[]> {
  const rows = await closesAsc(symbol)
  const flags: RiskFlag[] = []

  if (rows.length > 21) {
    const last = rows[rows.length - 1].close
    const m1 = rows[rows.length - 22].close
    const ret1M = ((last - m1) / m1) * 100
    const peak = Math.max(...rows.map((r) => r.close))
    const drawdown = ((last - peak) / peak) * 100
    const rets = rows.slice(1).map((r, i) => Math.log(r.close / rows[i].close))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100

    if (ret1M < -12) flags.push({ severity: 'high', title: `Sharp 1-month decline (${ret1M.toFixed(1)}%)`, description: `The stock has fallen ${Math.abs(ret1M).toFixed(1)}% over the last month of trading (NSE EOD data).`, signal: 'Price momentum' })
    else if (ret1M < -6) flags.push({ severity: 'medium', title: `Negative 1-month momentum (${ret1M.toFixed(1)}%)`, description: `Down ${Math.abs(ret1M).toFixed(1)}% over the last month against the broader market.`, signal: 'Price momentum' })
    if (drawdown < -25) flags.push({ severity: 'high', title: `Deep drawdown from recent peak (${drawdown.toFixed(1)}%)`, description: `Trading ${Math.abs(drawdown).toFixed(1)}% below its peak within the stored window.`, signal: 'Drawdown from peak' })
    if (vol > 45) flags.push({ severity: 'medium', title: `Elevated volatility (${vol.toFixed(0)}% annualised)`, description: 'Realised volatility is materially above the large-cap norm (~20-30%).', signal: 'Realised volatility' })
  }

  const sast = filings.filter((f) => f.category === 'Insider Trading / SAST')
  if (sast.length >= 3) flags.push({ severity: 'medium', title: `Ownership churn - ${sast.length} SAST/insider disclosures`, description: 'Multiple substantial-acquisition or insider disclosures in the current feed window.', signal: 'Exchange disclosures' })
  if (filings.some((f) => f.category === 'Credit Rating')) flags.push({ severity: 'medium', title: 'Recent credit rating event', description: 'A rating agency disclosure was filed recently - review the source PDF for direction.', signal: 'Exchange disclosures' })

  if (flags.length === 0) {
    flags.push({ severity: 'low', title: 'No elevated signals detected', description: 'Price action and recent disclosures show no outsized risk markers; standard equity-market risk applies.', signal: 'Composite screen (price + disclosures)' })
  }
  return flags
}

// --- AI desk note (cached 24h; deterministic stats fallback) ---

async function statsNote(symbol: string, name: string): Promise<string> {
  const rows = await closesAsc(symbol)
  if (rows.length < 5) return `${name} (${symbol}) is part of the NIFTY 500 universe. Price history is still being ingested; check the chart above for the latest data.`
  const last = rows[rows.length - 1]
  const first = rows[0]
  const ret = ((last.close - first.close) / first.close) * 100
  const hi = Math.max(...rows.map((r) => r.close))
  const lo = Math.min(...rows.map((r) => r.close))
  return `${name} (${symbol}) closed at ₹${last.close.toLocaleString('en-IN')} on ${last.date} (NSE EOD). Over the stored ${rows.length}-session window the stock moved ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%, ranging between ₹${lo.toLocaleString('en-IN')} and ₹${hi.toLocaleString('en-IN')}. See the announcements and corporate-action tabs for recent disclosures.`
}

const DESK_NOTE_AI_TTL = 24 * 3600_000
// M-B3: short TTL for a cached non-AI stats fallback. When the LLM is down we still
// don't want to retry the full cascade on every page view — cache the stats note
// briefly (ai:false), then re-attempt the LLM once it lapses.
const DESK_NOTE_STATS_TTL = 60 * 60_000

async function deskNote(symbol: string, name: string, filings: FilingOut[], news: CompanyNewsItem[]): Promise<{ note: string; ai: boolean }> {
  const cached = await deskNotesRepo.get(symbol)
  if (cached) {
    const age = Date.now() - new Date(cached.updatedAt).getTime()
    if (cached.ai && age < DESK_NOTE_AI_TTL) return { note: cached.note, ai: true }
    // A recently-cached stats fallback: serve it without re-hammering a down LLM.
    if (!cached.ai && age < DESK_NOTE_STATS_TTL) return { note: cached.note, ai: false }
  }

  if (llmAvailable()) {
    const stats = await statsNote(symbol, name)
    const context = [
      `PRICE: ${stats}`,
      filings.length ? `RECENT DISCLOSURES:\n${filings.slice(0, 6).map((f) => `- [${f.category}] ${f.aiSummary ?? f.title.slice(0, 120)}`).join('\n')}` : '',
      news.length ? `RECENT HEADLINES:\n${news.slice(0, 6).map((n) => `- ${n.headline}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    // Desk notes route to Gemini (better synthesis); falls back to Groq automatically.
    const out = await complete(
      [
        { role: 'system', content: 'You write 70-100 word desk notes on Indian listed companies for a private research terminal. Use the provided context - price action, disclosures, news themes - and end with a crisp directional take (constructive / cautious / neutral) when the facts support one. Plain text, no headers, no disclaimers.' },
        { role: 'user', content: `Company: ${name} (${symbol})\n\n${context}\n\nWrite the desk note.` },
      ],
      { ...routeFor('deskNote'), maxTokens: 220 },
    )
    if (out) {
      await deskNotesRepo.upsert(symbol, out.text.trim(), true, new Date().toISOString())
      return { note: out.text.trim(), ai: true }
    }
  }
  // LLM unavailable or failed: cache the stats fallback with a short TTL (ai:false) so
  // repeated views during an LLM outage don't each retry the whole cascade (M-B3).
  const note = await statsNote(symbol, name)
  await deskNotesRepo.upsert(symbol, note, false, new Date().toISOString()).catch(() => {})
  return { note, ai: false }
}

// --- Assembled feed ---

export async function companyFeed(symbol: string) {
  const sym = symbol.toUpperCase()
  const row = await getInstrument(sym)
  if (!row) return null

  const filings = (await latestFilings(400)).filter((f) => f.symbol === sym)
  const [news, actions] = await Promise.all([companyNews(row.name, sym), corporateActions(sym, filings)])
  const note = await deskNote(sym, row.name, filings, news)
  const flags = await riskFlags(sym, filings)

  return {
    symbol: sym,
    name: row.name,
    industry: row.industry,
    domain: row.domain,
    deskNote: note,
    news,
    corporateActions: actions,
    announcements: filings.filter((f) => f.category !== 'Corporate Action'),
    riskFlags: flags,
  }
}
