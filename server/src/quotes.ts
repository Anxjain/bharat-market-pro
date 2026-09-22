// Real-time(ish) quote adapter - Yahoo Finance chart API for NSE equities and
// Indian indices (~15-min delayed during market hours; fine for research use,
// clearly labeled in the UI). 60-second in-memory cache per instrument.
//
// Durable store: every batch is also appended to quotes_history (Postgres) so a
// price time-series accumulates over time. The cache stays the fast path; the DB
// is the durable record. Persistence is best-effort and never blocks the response.
//
// NOTE (from BUILD_PLAN research): true realtime redistribution needs a licensed
// vendor (TrueData/Global Datafeeds) or per-user broker login. Yahoo is the
// honest interim for the prototype->production bridge; this module is the seam
// where the licensed feed will plug in.

import * as quotesHistoryRepo from './repositories/quotesHistory'

interface Quote {
  key: string
  price: number
  prevClose: number
  changePct: number
  marketTime: string | null
  source: 'yahoo-delayed'
}

const INDEX_ALIASES: Record<string, string> = {
  'NIFTY 50': '^NSEI',
  SENSEX: '^BSESN',
  'NIFTY BANK': '^NSEBANK',
  'NIFTY IT': '^CNXIT',
  'NIFTY FIN SERVICE': '^CNXFIN',
  'INDIA VIX': '^INDIAVIX',
}

function toYahoo(key: string): string {
  if (INDEX_ALIASES[key]) return INDEX_ALIASES[key]
  if (key.startsWith('^')) return key
  return `${key.toUpperCase()}.NS`
}

const cache = new Map<string, { quote: Quote; at: number }>()
const CACHE_MS = 60_000

async function fetchOne(key: string): Promise<Quote | null> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote
  try {
    const y = toYahoo(key)
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number } }[] }
    }
    const meta = data.chart?.result?.[0]?.meta
    if (!meta?.regularMarketPrice || !meta.chartPreviousClose) return null
    const quote: Quote = {
      key,
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      changePct: Math.round(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 10000) / 100,
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      source: 'yahoo-delayed',
    }
    cache.set(key, { quote, at: Date.now() })
    return quote
  } catch {
    return null
  }
}

/** Append the freshly returned quotes to the durable history (best-effort). */
async function persist(quotes: Quote[]): Promise<void> {
  if (quotes.length === 0) return
  const ts = new Date().toISOString()
  try {
    await quotesHistoryRepo.insertMany(quotes.map((q) => ({ symbol: q.key, price: q.price, changePct: q.changePct, ts })))
  } catch (e) {
    console.warn('[quotes] history persist failed:', (e as Error).message)
  }
}

/** Batch quotes (parallel, individually fault-tolerant); also persisted to history. */
export async function getQuotes(keys: string[]): Promise<Quote[]> {
  const unique = [...new Set(keys.filter(Boolean))].slice(0, 25)
  const results = await Promise.all(unique.map(fetchOne))
  const quotes = results.filter((q): q is Quote => q !== null)
  await persist(quotes)
  return quotes
}
