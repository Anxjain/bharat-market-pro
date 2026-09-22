// 5-day winning streaks — names that closed HIGHER every single session for the last
// 5 trading days (not one down day), ranked by cumulative gain. Built entirely from the
// daily NSE bhavcopy store (`prices`), which the scheduler ingests every evening — so
// this IS the "we track every company every day" record, read back as a streak screen.
//
// Honesty rules, same spirit as the rest of the desk:
//   • strictly-higher closes only — a flat day breaks the streak (no rounding grace)
//   • a name must have TRADED all 6 sessions (5 gains need 6 closes); a missing bar
//     (suspension, listing gap) disqualifies rather than being papered over
//   • illiquid names are dropped (avg turnover < ₹1cr) — a "streak" on no volume is
//     an artefact of a thin order book, not demand
import * as pricesRepo from '../repositories/prices'
import * as instrumentsRepo from '../repositories/instruments'

export const STREAK_DAYS = 5
const TOP_N = 5
const MIN_TURNOVER_CR = 1 // avg daily traded value across the window, in ₹ crore

export interface StreakEntry {
  symbol: string
  name: string | null
  totalPct: number // cumulative gain across the streak window
  dailyPct: number[] // per-session gain, oldest → newest (STREAK_DAYS entries, all > 0)
  price: number // latest close
  from: string // first up-close session (YYYY-MM-DD)
  to: string // latest session (YYYY-MM-DD)
  avgTurnoverCr: number
}

export interface Streaks {
  asOf: string | null // latest ingested session the screen is computed on
  days: number
  entries: StreakEntry[] // top TOP_N by cumulative gain
  scanned: number // symbols with a full window of bars
  qualified: number // symbols that passed the streak + liquidity test (before top-N cut)
  note: string
}

// One board per ingested session — recomputes only when a new bhavcopy lands.
let cache: { key: string; value: Streaks } | null = null

export async function computeStreaks(): Promise<Streaks> {
  const dates = await pricesRepo.distinctRecentDates(STREAK_DAYS + 1) // newest first
  if (dates.length < STREAK_DAYS + 1) {
    return {
      asOf: dates[0] ?? null,
      days: STREAK_DAYS,
      entries: [],
      scanned: 0,
      qualified: 0,
      note: `needs ${STREAK_DAYS + 1} ingested sessions, have ${dates.length} — the daily price ingest fills this in`,
    }
  }
  if (cache?.key === dates[0]) return cache.value

  const window = new Set(dates)
  const rows = await pricesRepo.since(dates[dates.length - 1]) // ordered symbol asc, date asc
  const bySym = new Map<string, { date: string; close: number; volume: number }[]>()
  for (const r of rows) {
    if (!window.has(r.date)) continue
    let arr = bySym.get(r.symbol)
    if (!arr) bySym.set(r.symbol, (arr = []))
    arr.push(r)
  }

  const all: StreakEntry[] = []
  let scanned = 0
  for (const [symbol, arr] of bySym) {
    if (arr.length !== STREAK_DAYS + 1) continue // must have a bar for every session
    scanned++
    let up = true
    for (let i = 1; i < arr.length; i++) {
      if (!(arr[i].close > arr[i - 1].close)) { up = false; break }
    }
    if (!up) continue
    const avgTurnoverCr = arr.reduce((s, r) => s + r.close * r.volume, 0) / arr.length / 1e7
    if (avgTurnoverCr < MIN_TURNOVER_CR) continue
    const dailyPct: number[] = []
    for (let i = 1; i < arr.length; i++) dailyPct.push(((arr[i].close - arr[i - 1].close) / arr[i - 1].close) * 100)
    const last = arr[arr.length - 1]
    all.push({
      symbol,
      name: null,
      totalPct: (last.close / arr[0].close - 1) * 100,
      dailyPct,
      price: last.close,
      from: arr[1].date,
      to: last.date,
      avgTurnoverCr: Math.round(avgTurnoverCr * 10) / 10,
    })
  }

  all.sort((a, b) => b.totalPct - a.totalPct)
  const entries = all.slice(0, TOP_N)
  const names = new Map((await instrumentsRepo.listSymbolName()).map((r) => [r.symbol, r.name]))
  for (const e of entries) e.name = names.get(e.symbol) ?? null

  const value: Streaks = {
    asOf: dates[0],
    days: STREAK_DAYS,
    entries,
    scanned,
    qualified: all.length,
    note:
      all.length === 0
        ? `no name closed higher on all ${STREAK_DAYS} of the last ${STREAK_DAYS} sessions (min ₹${MIN_TURNOVER_CR}cr avg turnover)`
        : `${all.length} of ${scanned} names on a full ${STREAK_DAYS}-session streak; showing the top ${entries.length} by cumulative gain (min ₹${MIN_TURNOVER_CR}cr avg turnover)`,
  }
  cache = { key: dates[0], value }
  return value
}
