// "Explain this move" (9.4) — one call assembles the causal story for a company's move
// on a given day: the price context (stock vs index), the day's disclosures, news and
// corporate actions around it, and a grounded ≤3-sentence LLM narrative built ONLY from
// that evidence. When nothing company-specific explains the move, it says so honestly
// (sector/market beta) instead of inventing a cause. Public endpoint (Company360 uses it).
import { getInstrument } from './repositories/instruments'
import { closesAsc } from './repositories/prices'
import * as guidanceFilingsRepo from './repositories/guidanceFilings'
import * as histRepo from './repositories/guidancePriceHistory'
import { companyNews, corporateActions, type CompanyNewsItem, type CorporateAction } from './company-feed'
import { complete, llmAvailable, routeFor } from './llm'

export interface ExplainEvidence {
  filings: { date: string; title: string; category: string | null; link: string | null }[]
  news: { date: string; headline: string; source: string; sentiment: string }[]
  corpActions: { date: string; type: string; detail: string }[]
}

export interface Explanation {
  symbol: string
  name: string | null
  date: string // the explained trading day
  movePct: number
  close: number
  move5dPct: number | null
  indexMovePct: number | null // NIFTY same-day move (beta context)
  narrative: string
  source: 'llm' | 'stats' // stats = deterministic fallback when no LLM is available
  evidence: ExplainEvidence
}

const cache = new Map<string, { value: Explanation; at: number }>()
const CACHE_MS = 24 * 60 * 60 * 1000

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 10000) / 100 : 0)
const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
/** date-only compare helper: ISO timestamps and YYYY-MM-DD sort together on slice(0,10) */
const day = (iso: string) => iso.slice(0, 10)
const addDays = (isoDay: string, n: number) => new Date(new Date(`${isoDay}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)

/** Deterministic fallback narrative — same evidence, no LLM. */
function statsNarrative(e: Explanation): string {
  const dir = e.movePct >= 0 ? 'rose' : 'fell'
  const parts: string[] = [`${e.symbol} ${dir} ${Math.abs(e.movePct).toFixed(1)}% on ${e.date}.`]
  if (e.indexMovePct != null && Math.abs(e.indexMovePct) >= 0.8 && Math.sign(e.indexMovePct) === Math.sign(e.movePct)) {
    parts.push(`The broad market moved ${fmtPct(e.indexMovePct)} the same day, so much of this is market beta.`)
  }
  const top = e.evidence.filings[0] ?? null
  const news = e.evidence.news[0] ?? null
  if (top) parts.push(`Same-window disclosure: "${top.title}" (${top.date}).`)
  else if (news) parts.push(`Nearby headline: "${news.headline}" (${news.source}, ${news.date}).`)
  else parts.push('No company-specific disclosure or headline sits in the window — likely sector/market-driven or flow-driven.')
  return parts.join(' ')
}

/**
 * Explain the move on `dateArg` (YYYY-MM-DD; default = the latest stored session).
 * Returns null when the symbol isn't in the universe or the date has no price row.
 */
export async function explainMove(symbol: string, dateArg?: string): Promise<Explanation | null> {
  const sym = symbol.toUpperCase()
  const inst = await getInstrument(sym)
  if (!inst) return null

  const closes = await closesAsc(sym)
  if (closes.length < 2) return null
  let i = closes.length - 1
  if (dateArg) {
    i = closes.findIndex((c) => day(c.date) === dateArg)
    if (i < 1) return null // unknown date, or the very first row (no prev close to move from)
  }
  const date = day(closes[i].date)

  const key = `${sym}|${date}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const movePct = pct(closes[i].close, closes[i - 1].close)
  const move5dPct = i >= 5 ? pct(closes[i].close, closes[i - 5].close) : null

  // NIFTY the same day — separates "the stock fell" from "everything fell".
  const idx = await histRepo.closesAsc('^NSEI').catch(() => [])
  let indexMovePct: number | null = null
  const j = idx.findIndex((c) => day(c.date) === date)
  if (j >= 1) indexMovePct = pct(idx[j].close, idx[j - 1].close)

  // Evidence windows: filings/corp-actions 7 days back (a Friday filing moves Monday's
  // price), news 3 days back — all capped at the day AFTER the move (later events can't
  // have caused it).
  const until = addDays(date, 1)
  const [filingRows, newsItems, caItems] = await Promise.all([
    guidanceFilingsRepo.forSymbolSince(sym, `${addDays(date, -7)}T00:00:00Z`).catch(() => []),
    companyNews(inst.name ?? sym, sym).catch(() => [] as CompanyNewsItem[]),
    corporateActions(sym, []).catch(() => [] as CorporateAction[]),
  ])
  const evidence: ExplainEvidence = {
    filings: filingRows
      .filter((f) => day(f.filedAt) <= until)
      .slice(0, 6)
      .map((f) => ({ date: day(f.filedAt), title: f.title, category: f.category ?? null, link: f.link ?? null })),
    news: newsItems
      .filter((n) => day(n.publishedAt) >= addDays(date, -3) && day(n.publishedAt) <= until)
      .slice(0, 6)
      .map((n) => ({ date: day(n.publishedAt), headline: n.headline, source: n.source, sentiment: n.sentiment })),
    corpActions: caItems
      .filter((a) => a.date >= addDays(date, -10) && a.date <= until)
      .slice(0, 4)
      .map((a) => ({ date: a.date, type: a.type, detail: a.detail })),
  }

  const base: Explanation = {
    symbol: sym,
    name: inst.name ?? null,
    date,
    movePct,
    close: closes[i].close,
    move5dPct,
    indexMovePct,
    narrative: '',
    source: 'stats',
    evidence,
  }

  if (llmAvailable()) {
    const ev = [
      `Stock: ${inst.name ?? sym} (${sym}) moved ${fmtPct(movePct)} on ${date} (close ₹${closes[i].close}).${move5dPct != null ? ` 5-day move ${fmtPct(move5dPct)}.` : ''}`,
      indexMovePct != null ? `NIFTY moved ${fmtPct(indexMovePct)} the same day.` : 'Index move for the day unavailable.',
      evidence.filings.length
        ? `Exchange filings (7d window): ${evidence.filings.map((f) => `[${f.date}] ${f.title}`).join(' | ')}`
        : 'No exchange filings in the 7-day window.',
      evidence.news.length
        ? `News (3d window): ${evidence.news.map((n) => `[${n.date}, ${n.source}, ${n.sentiment}] ${n.headline}`).join(' | ')}`
        : 'No company-specific news in the 3-day window.',
      evidence.corpActions.length ? `Corporate actions nearby: ${evidence.corpActions.map((a) => `[${a.date}] ${a.type} — ${a.detail}`).join(' | ')}` : '',
    ].filter(Boolean).join('\n')

    const res = await complete(
      [
        {
          role: 'system',
          content:
            'You explain a single day\'s move in an Indian stock. Use ONLY the evidence provided — never invent filings, news, or numbers. Write at most 3 sentences, plain English, each cause cited with its date in parentheses. If the evidence contains nothing company-specific, attribute the move to market/sector direction (using the index move if given) and say plainly that no company-specific driver was disclosed. No disclaimers, no hedging boilerplate.',
        },
        { role: 'user', content: ev },
      ],
      { ...routeFor('deskNote'), maxTokens: 220 },
    ).catch(() => null)
    if (res?.text?.trim()) {
      base.narrative = res.text.trim()
      base.source = 'llm'
    }
  }
  if (!base.narrative) base.narrative = statsNarrative(base)

  cache.set(key, { value: base, at: Date.now() })
  return base
}
