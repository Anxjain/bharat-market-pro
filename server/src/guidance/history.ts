// Deep daily price history for the guidance base-rate engine.
//
// Source: Yahoo Finance chart API (the same vendor quotes.ts already uses). For an
// NSE symbol `X` we request `X.NS` with interval=1d & range=max, which returns the
// FULL multi-year daily series — years deep, vs the ~98-day live `prices` ingest.
// This is, in effect, "full NSE history" per symbol without hitting NSE's archive
// throttling. Adjusted close is preferred where Yahoo supplies it so splits/dividends
// don't create phantom gaps that would distort recovery statistics.
//
// The engine reads the DEEPEST series available per symbol (deepCloses): this table
// first, then the live `prices` store as a fallback.
import * as histRepo from '../repositories/guidancePriceHistory'
import * as pricesRepo from '../repositories/prices'

const YH = 'https://query1.finance.yahoo.com/v8/finance/chart'

function toYahoo(symbol: string): string {
  return symbol.startsWith('^') ? symbol : `${symbol.toUpperCase()}.NS`
}

export interface FetchedCandle {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]
          high?: (number | null)[]
          low?: (number | null)[]
          close?: (number | null)[]
          volume?: (number | null)[]
        }>
        adjclose?: Array<{ adjclose?: (number | null)[] }>
      }
    }>
  }
}

/** Fetch daily history for a symbol from Yahoo (oldest → newest).
 *  NOTE: `range=max` with `interval=1d` DECIMATES long spans (e.g. SBIN → ~367 points).
 *  Explicit period1=0..now returns the true daily series (SBIN → ~7,600 rows).
 *  `sinceEpochSec` fetches only the tail (CR-7 incremental refresh) — pass the last stored
 *  date's epoch so we pull just the fresh bars rather than the whole multi-year series. */
export async function fetchYahooHistory(symbol: string, sinceEpochSec = 0): Promise<FetchedCandle[]> {
  const now = Math.floor(Date.now() / 1000)
  const period1 = Math.max(0, Math.floor(sinceEpochSec))
  const url = `${YH}/${encodeURIComponent(toYahoo(symbol))}?interval=1d&period1=${period1}&period2=${now}&events=div%2Csplit`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return []
  const data = (await res.json()) as YahooChart
  const r = data.chart?.result?.[0]
  if (!r?.timestamp) return []
  const ts = r.timestamp
  const q = r.indicators?.quote?.[0] ?? {}
  const adj = r.indicators?.adjclose?.[0]?.adjclose
  const out: FetchedCandle[] = []
  for (let i = 0; i < ts.length; i++) {
    const close = adj?.[i] ?? q.close?.[i]
    // Guard NaN/Infinity too (not just null) — a bad close leaks "+NaN%" into every
    // downstream % (drop_1d, drawdown, base rate) and reaches the UI. (L: NaN leaks.)
    if (close == null || !Number.isFinite(close)) continue
    out.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close,
      volume: q.volume?.[i] ?? null,
    })
  }
  return out
}

/** Number of calendar days after which the stored tail is considered stale. Three
 *  trading days ≈ 5 calendar days once a weekend is included; we use a little slack so a
 *  long weekend / holiday doesn't trigger a needless refetch. */
const STALE_TAIL_DAYS = 5

/** True when the latest stored bar is older than the freshness cutoff. */
function tailIsStale(latest: string | null): boolean {
  if (!latest) return true
  const ageMs = Date.now() - Date.parse(`${latest}T00:00:00Z`)
  return ageMs > STALE_TAIL_DAYS * 864e5
}

/**
 * Ensure deep history is stored for a symbol; returns the stored row count.
 *
 * Refetches when EITHER:
 *   • we have fewer than `minRows` (≈ a year of trading days) — a "do we have depth?" gate, or
 *   • the stored tail is stale (CR-7): `max(date)` is older than ~3 trading days. Daily
 *     bhavcopy only writes the live `prices` table, never `guidance_price_history`, so
 *     without this the timing axis (drop_1d/RSI/MAs/drawdown/base-rate direction) silently
 *     computes on a frozen series that ends at backfill date and drifts staler every day.
 *   • or `force`.
 *
 * A stale-tail refetch is INCREMENTAL — it pulls only from the last stored date forward
 * (period1 = lastStoredDate) instead of re-downloading the whole multi-year series; the
 * upsert's ON CONFLICT DO UPDATE reconciles the (usually single) overlapping bar.
 */
export async function ensureHistory(symbol: string, opts: { minRows?: number; force?: boolean } = {}): Promise<number> {
  const sym = symbol.toUpperCase()
  const have = await histRepo.count(sym)
  const minRows = opts.minRows ?? 250
  const latest = await histRepo.latestDate(sym)
  const needDepth = have < minRows
  const needFresh = tailIsStale(latest)
  if (!opts.force && !needDepth && !needFresh) return have

  // Incremental when we're only refreshing a stale tail on an otherwise-deep series;
  // full pull when depth is missing or forced.
  const incremental = !opts.force && !needDepth && needFresh && latest != null
  const sinceSec = incremental ? Math.floor(Date.parse(`${latest}T00:00:00Z`) / 1000) : 0
  const candles = await fetchYahooHistory(sym, sinceSec)
  if (candles.length === 0) return have
  await histRepo.upsertMany(sym, candles, 'yahoo')
  return histRepo.count(sym)
}

/**
 * CR-7 nightly tail-refresh: incrementally top up the deep series for a set of symbols
 * (the watchlist + latest opportunity board) AFTER the 18:30 bhavcopy ingest, so the
 * guidance timing axis never scores a months-old bar. A function the scan scheduler can
 * call; kept here so history logic stays in one place.
 *
 * CROSS-FILE NOTE (see report): the actual wiring — invoking this after the daily ingest —
 * belongs in `scheduler.ts`, which is owned by another engineer. Suggested: after the
 * price-ingest job completes, call `tailRefresh(await watchlistAndBoardSymbols())`.
 */
export async function tailRefresh(symbols: string[], opts: { delayMs?: number } = {}): Promise<{ refreshed: number; skipped: number }> {
  const delay = opts.delayMs ?? 400
  let refreshed = 0
  let skipped = 0
  for (const raw of symbols) {
    const sym = raw.toUpperCase()
    try {
      const latest = await histRepo.latestDate(sym)
      // Only touch names that actually have a deep series but a stale tail; a name with no
      // depth is left for the full backfill job.
      const have = await histRepo.count(sym)
      if (have >= 60 && tailIsStale(latest)) {
        await ensureHistory(sym)
        refreshed++
        await new Promise((r) => setTimeout(r, delay)) // be polite to Yahoo
      } else {
        skipped++
      }
    } catch {
      skipped++
    }
  }
  return { refreshed, skipped }
}

/** The DEEPEST close series available for a symbol: guidance_price_history if we have a
 *  usable amount, otherwise the live `prices` store. The base-rate engine uses this so
 *  it transparently improves as deep history is backfilled, and still works offline. */
export async function deepCloses(symbol: string): Promise<{ date: string; close: number }[]> {
  const sym = symbol.toUpperCase()
  const deep = await histRepo.closesAsc(sym)
  if (deep.length >= 60) return deep
  const live = await pricesRepo.closesAsc(sym)
  return live.length > deep.length ? live : deep
}

/** The deepest OHLCV candle series available (for volume-based factors). */
export async function deepCandles(symbol: string): Promise<histRepo.Candle[]> {
  const sym = symbol.toUpperCase()
  const deep = await histRepo.candlesAsc(sym)
  if (deep.length >= 60) return deep
  const live = await pricesRepo.equityRows(sym)
  if (live.length > deep.length) {
    return live.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
  }
  return deep
}

/** True once a symbol has multi-year depth (used to set lowConfidence honestly). */
export async function hasDeepHistory(symbol: string): Promise<boolean> {
  return (await histRepo.count(symbol.toUpperCase())) >= 250
}
