// The measurement loop — forward-outcome labels for every (symbol, session).
//
// A prediction tool that never grades itself is a horoscope. Every night this appends
// what ACTUALLY happened 5/20/60 sessions after each date — both raw return and excess
// over the NIFTY (x*), because "went up in a bull market" is not skill. The label store
// then serves three masters:
//   1. grading — every tier call the desk snapshotted, scored vs the index (gradeTiers)
//   2. the ML ranker — training targets (scripts/ml exports features × these labels)
//   3. benchmarking — the paper portfolio's per-trade alpha (indexReturnPct)
import '../load-env'
import * as histRepo from '../repositories/guidancePriceHistory'
import * as pricesRepo from '../repositories/prices'
import * as indexRepo from '../repositories/indexPrices'
import * as instrumentsRepo from '../repositories/instruments'
import * as labelsRepo from '../repositories/guidanceLabels'

const HORIZONS = [5, 20, 60] as const
const round2 = (n: number) => Math.round(n * 100) / 100

// ——— NIFTY close lookup (merged: deep ^NSEI history + the daily index ingest) ———

export interface NiftySeries {
  map: Map<string, number>
  dates: string[] // ascending
}

let niftyCache: { at: number; series: NiftySeries } | null = null

export async function niftySeries(): Promise<NiftySeries> {
  if (niftyCache && Date.now() - niftyCache.at < 10 * 60_000) return niftyCache.series
  const map = new Map<string, number>()
  for (const r of await histRepo.closesAsc('^NSEI').catch(() => [])) map.set(r.date, r.close)
  // the daily ingest is the fresher source for the recent window — overlay it
  for (const r of await indexRepo.indexRows('Nifty 50').catch(() => [])) map.set(r.date, r.c)
  const dates = [...map.keys()].sort()
  const series = { map, dates }
  niftyCache = { at: Date.now(), series }
  return series
}

/** NIFTY close on the given session, else the nearest earlier session (weekends/gaps). */
function niftyOnOrBefore(s: NiftySeries, date: string): number | null {
  const exact = s.map.get(date)
  if (exact != null) return exact
  // binary search for the greatest date <= target
  let lo = 0
  let hi = s.dates.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s.dates[mid] <= date) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  return best >= 0 ? (s.map.get(s.dates[best]) ?? null) : null
}

/** NIFTY % return between two dates (nearest-earlier session on each side). Null when
 *  the window isn't covered — callers must show "—", never assume 0. */
export async function indexReturnPct(from: string, to: string): Promise<number | null> {
  const s = await niftySeries()
  const a = niftyOnOrBefore(s, from)
  const b = niftyOnOrBefore(s, to)
  if (a == null || b == null || a === 0) return null
  return round2(((b - a) / a) * 100)
}

// ——— label building ———

function labelsForSeries(symbol: string, closes: { date: string; close: number }[], nifty: NiftySeries, since: string): labelsRepo.LabelRow[] {
  const out: labelsRepo.LabelRow[] = []
  for (let i = 0; i < closes.length; i++) {
    const base = closes[i]
    if (base.date < since || base.close <= 0) continue
    const row: labelsRepo.LabelRow = { symbol, date: base.date, r5: null, r20: null, r60: null, x5: null, x20: null, x60: null }
    let any = false
    for (const h of HORIZONS) {
      const fwd = closes[i + h]
      if (!fwd) continue // not matured yet — upserted as null, filled by a later run
      const r = round2(((fwd.close - base.close) / base.close) * 100)
      const n0 = niftyOnOrBefore(nifty, base.date)
      const n1 = niftyOnOrBefore(nifty, fwd.date)
      const x = n0 != null && n1 != null && n0 !== 0 ? round2(r - ((n1 - n0) / n0) * 100) : null
      if (h === 5) { row.r5 = r; row.x5 = x } else if (h === 20) { row.r20 = r; row.x20 = x } else { row.r60 = r; row.x60 = x }
      any = true
    }
    if (any) out.push(row)
  }
  return out
}

/** Build/refresh labels for all instruments from `since` (YYYY-MM-DD). Deep history
 *  preferred, live price store as fallback. Idempotent (PK upsert) and resumable. */
export async function buildLabels(opts: { since: string; symbols?: string[] }): Promise<{ symbols: number; rows: number }> {
  const symbols = opts.symbols ?? (await instrumentsRepo.listSymbols())
  const nifty = await niftySeries()
  let rows = 0
  let done = 0
  for (const sym of symbols) {
    try {
      let closes = await histRepo.closesAsc(sym)
      if (closes.length < 70) closes = await pricesRepo.closesAsc(sym)
      if (closes.length < 10) continue
      rows += await labelsRepo.upsertMany(labelsForSeries(sym, closes, nifty, opts.since))
    } catch (e) {
      console.warn(`[labels] ${sym} failed: ${(e as Error).message}`)
    }
    done++
    if (done % 100 === 0) console.log(`[labels] ${done}/${symbols.length} symbols, ${rows} rows`)
  }
  return { symbols: done, rows }
}

/** Nightly: refresh the recent window so labels mature as their horizons complete
 *  (a date's r60 becomes known 60 sessions later). ~130 calendar days covers 60
 *  sessions with margin. Never throws — scheduler path. */
export async function nightlyLabelUpdate(): Promise<void> {
  try {
    const d = new Date()
    d.setDate(d.getDate() - 130)
    const since = d.toISOString().slice(0, 10)
    const r = await buildLabels({ since })
    console.log(`[labels] nightly update: ${r.rows} rows across ${r.symbols} symbols (since ${since})`)
  } catch (e) {
    console.warn('[labels] nightly update failed:', (e as Error).message)
  }
}

// ——— CLI: npm run guidance:labels [-- --since 2019-01-01] ———
if (process.argv[1]?.replace(/\\/g, '/').endsWith('guidance/labels.ts')) {
  ;(async () => {
    const { pool } = await import('../db/client')
    const i = process.argv.indexOf('--since')
    const since = i > -1 ? process.argv[i + 1] : '2019-01-01'
    console.log(`[labels] full build since ${since}…`)
    const r = await buildLabels({ since })
    console.log(`[labels] done — ${r.rows} label rows across ${r.symbols} symbols`)
    await pool.end()
  })().catch((e) => { console.error('[labels] fatal:', e); process.exit(1) })
}
