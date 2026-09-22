// LIVE filings adapter - NSE's official disclosure RSS feeds (nsearchives host,
// same legitimate source as the bhavcopy). Five streams -> one normalized table.
//
// Pipeline: fetch feeds -> categorize -> upsert into Postgres -> AI-enrich the
// newest rows via the LLM adapter (2-line descriptive summary + materiality).
// When no LLM key is configured, heuristic materiality + raw description serve.
// All SQL lives in the filings repository.

import { completeJson, llmAvailable, routeFor } from './llm'
import * as filingsRepo from './repositories/filings'
import { listSymbolName } from './repositories/instruments'
import { hashId, makeRssParser } from './util/shared'

const FEEDS: { url: string; defaultCategory: string }[] = [
  { url: 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml', defaultCategory: 'Regulatory' },
  { url: 'https://nsearchives.nseindia.com/content/RSS/Insider_Trading.xml', defaultCategory: 'Insider Trading / SAST' },
  { url: 'https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml', defaultCategory: 'Board Meeting' },
  { url: 'https://nsearchives.nseindia.com/content/RSS/Corporate_action.xml', defaultCategory: 'Corporate Action' },
  { url: 'https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml', defaultCategory: 'Financial Results' },
]

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** H-18: parse NSE's "12-Jun-2026 11:20:39" (always IST) explicitly with a +05:30
 *  offset and normalize to UTC ISO. M-B10: return null on unparseable input rather
 *  than fabricating now() (a bad date used to jump to the top of every recency view). */
function parseNseDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2}:\d{2})$/)
  if (!m || !MONTHS[m[2]]) return null
  const ms = Date.parse(`${m[3]}-${MONTHS[m[2]]}-${m[1]}T${m[4]}+05:30`)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** Resolve a filing timestamp to UTC ISO. The rss-parser `isoDate` is NOT trusted for
 *  this feed — V8 parses NSE's non-RFC822 date string in server-local time, skewing
 *  ordering by up to 5.5h. We always parse the raw NSE pubDate ourselves. Returns null
 *  when unparseable so the caller skips the row instead of fabricating a time (M-B10). */
function resolveFiledAt(_isoDate?: string, pubDate?: string): string | null {
  return parseNseDate((pubDate ?? '').toString())
}

function categorize(text: string, fallback: string): string {
  const t = text.toLowerCase()
  if (/regulation 31|sast|insider|pit\b|pledge/.test(t)) return 'Insider Trading / SAST'
  if (/board meeting/.test(t)) return 'Board Meeting'
  if (/financial result|results for the quarter|un-audited|unaudited|audited financial/.test(t)) return 'Financial Results'
  if (/order|contract|loa|letter of award|bagged/.test(t)) return 'Order Win / Contract'
  if (/credit rating|crisil|icra|care ratings/.test(t)) return 'Credit Rating'
  if (/investor presentation|press release|earnings call|analyst/.test(t)) return 'Investor Presentation'
  if (/dividend|bonus|split|record date|buyback|rights issue|demerger|amalgamation/.test(t)) return 'Corporate Action'
  return fallback
}

function heuristicMateriality(category: string, text: string): 'high' | 'medium' | 'low' {
  const t = text.toLowerCase()
  if (/fraud|default|resignation of (statutory )?auditor|insolvency|sebi order|penalty/.test(t)) return 'high'
  if (category === 'Financial Results' || category === 'Order Win / Contract' || category === 'Credit Rating') return 'high'
  if (category === 'Insider Trading / SAST' || category === 'Board Meeting') return 'low'
  return 'medium'
}

/** Normalize a company name for symbol lookup against the instruments master. */
function normName(s: string): string {
  return s.toLowerCase().replace(/\b(limited|ltd\.?|india)\b/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

// H-22: TTL the name→symbol map (30 min) and refuse to cache an empty result. The
// map is filled from the instruments master, which is empty until the first ingest
// (runs ~30s after boot). Caching an empty map forever pinned filing tagging OFF for
// the whole process life if warm() ran before that ingest.
let symbolByName: { map: Map<string, string>; at: number } | null = null
const SYMBOL_MAP_TTL_MS = 30 * 60 * 1000
async function getSymbolMap(): Promise<Map<string, string>> {
  if (symbolByName && Date.now() - symbolByName.at < SYMBOL_MAP_TTL_MS) return symbolByName.map
  const rows = await listSymbolName()
  const map = new Map(rows.map((r) => [normName(r.name), r.symbol]))
  if (map.size > 0) symbolByName = { map, at: Date.now() } // don't pin an empty result
  return map
}

const parser = makeRssParser(15_000)

let lastFetch = 0
const FETCH_MS = 10 * 60 * 1000
const RETRY_MS = 60 * 1000 // on an all-feeds-failed cycle, retry sooner than a full window

/** Pull all five feeds and upsert new filings. */
export async function refreshFilings(): Promise<void> {
  if (Date.now() - lastFetch < FETCH_MS) return

  const symbolMap = await getSymbolMap()
  const results = await Promise.allSettled(FEEDS.map((f) => parser.parseURL(f.url).then((feed) => ({ f, feed }))))

  // M-B7: only advance lastFetch once at least one feed actually fulfilled. If all five
  // reject (NSE down / network blip) we log and retry on the next cycle instead of
  // silently marking success and going quiet for 10 minutes.
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length
  if (fulfilled === 0) {
    console.warn('[filings] all feeds failed this cycle — will retry shortly')
    lastFetch = Date.now() - (FETCH_MS - RETRY_MS)
    return
  }
  lastFetch = Date.now()

  const rows: {
    id: string; exchange: string; symbol: string | null; company: string; category: string; title: string; filedAt: string; link: string; materiality: string
  }[] = []
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    const { f, feed } = r.value
    for (const item of feed.items ?? []) {
      const company = (item.title ?? '').trim()
      const desc = (item.content ?? item.contentSnippet ?? '').replace(/\s+/g, ' ').trim()
      const link = (item.link ?? '').trim()
      const filedAt = resolveFiledAt(item.isoDate, (item.pubDate ?? '').toString())
      if (!company || !link || !filedAt) continue // skip rows with an unparseable timestamp (M-B10)
      const category = categorize(desc, f.defaultCategory)
      rows.push({
        id: hashId(link),
        exchange: 'NSE',
        symbol: symbolMap.get(normName(company)) ?? null,
        company,
        category,
        title: desc || company,
        filedAt,
        link,
        materiality: heuristicMateriality(category, desc),
      })
    }
  }
  await filingsRepo.upsertFilings(rows)
}

interface EnrichResult {
  summary: string
  materiality: 'high' | 'medium' | 'low'
}

const ENRICH_SYSTEM = `You are a markets research assistant for Indian equities. Given a corporate disclosure, return JSON: {"summary": string, "materiality": "high"|"medium"|"low"}.
- summary: ONE factual sentence (max 28 words) describing what the disclosure says and why an analyst might care.
- materiality: high = market-moving (results, large orders, ratings, fraud, auditor changes, big stake changes); medium = notable; low = routine compliance.`

/**
 * AI-enrich the newest un-enriched filings (bounded per cycle). Routing by materiality:
 *   high   -> Gemini (better reasoning on market-moving disclosures)
 *   medium -> Groq free bulk model (high volume, fast/free)
 *   low    -> skipped (auto-marked, no AI)
 * Cross-provider fallback is automatic inside completeJson(); if a routed provider is
 * unavailable/rate-limited it uses the other so enrichment never stalls.
 */
export async function enrichFilings(limit = 8): Promise<number> {
  if (!llmAvailable()) return 0
  // Routine low-materiality disclosures (bulk of the SAST stream) don't need AI digests.
  await filingsRepo.markLowEnriched()
  const rows = await filingsRepo.unenriched(limit)

  let n = 0
  let failures = 0
  for (const row of rows) {
    // HIGH -> Gemini, MEDIUM -> Groq bulk; the seam falls back to the other provider.
    const opts = routeFor(row.materiality === 'high' ? 'filingHigh' : 'filingMedium')
    const out = await completeJson<EnrichResult>(
      ENRICH_SYSTEM,
      `Company: ${row.company}\nCategory guess: ${row.category}\nDisclosure text: ${row.title.slice(0, 900)}`,
      opts,
    )
    if (out?.summary) {
      const mat = ['high', 'medium', 'low'].includes(out.materiality) ? out.materiality : 'medium'
      await filingsRepo.markEnriched(row.id, out.summary.slice(0, 300), mat)
      n++
      failures = 0
    } else if (++failures >= 2) {
      break // both providers struggling - stop this cycle, retry next warmer pass
    }
  }
  return n
}

export interface FilingOut {
  id: string
  exchange: 'NSE'
  symbol: string | null
  company: string
  category: string
  title: string
  filedAt: string
  link: string
  aiSummary: string | null
  materiality: 'high' | 'medium' | 'low'
  ai: boolean
}

export async function latestFilings(limit = 80): Promise<FilingOut[]> {
  const rows = await filingsRepo.latest(limit)
  return rows.map((r) => ({
    id: r.id,
    exchange: 'NSE',
    symbol: r.symbol,
    company: r.company,
    category: r.category,
    title: r.title,
    filedAt: r.filedAt,
    link: r.link,
    aiSummary: r.summary,
    materiality: r.materiality as 'high' | 'medium' | 'low',
    ai: r.ai,
  }))
}
