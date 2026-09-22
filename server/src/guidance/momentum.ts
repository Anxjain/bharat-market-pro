// Momentum board — the core engine for the 3–18 month holder.
//
// Cross-sectional momentum is the one price signal with decades of evidence at this
// horizon (it is the basis of NSE's own Nifty200 Momentum 30 index): buy what has been
// strongest over the last 3–6 months, SKIPPING the most recent month (which mean-reverts),
// hold a quarter or two, re-rank. This board ranks the whole NIFTY-500 universe by
//   score = 0.6 × 6-month return + 0.4 × 3-month return   (both measured up to ~21
//   sessions ago), liquidity-filtered, with two honesty overlays:
//   • earnings confirmation — price momentum backed by improving quarterly profits is
//     the strongest bucket; momentum with deteriorating earnings is flagged as a trap.
//   • quality gate — names whose cached fundamentals force-avoid (risk block) are cut.
// Recomputed once per ingested session (cached), so it behaves like a weekly/monthly
// rebalance list, not a daily churn feed.
import * as histRepo from '../repositories/guidancePriceHistory'
import * as pricesRepo from '../repositories/prices'
import * as instrumentsRepo from '../repositories/instruments'
import * as resultsRepo from '../repositories/guidanceResults'
import * as fundRepo from '../repositories/guidanceFundamentals'
import type { ResultsTrend } from './results'
import type { Fundamentals } from './fundamentals'

const SKIP = 21 // sessions skipped (the mean-reverting recent month)
const W6 = 126 // ~6 trading months
const W3 = 63 // ~3 trading months
const MIN_TURNOVER_CR = 5
const TOP_N = 20
const round2 = (n: number) => Math.round(n * 100) / 100

export interface MomentumEntry {
  rank: number
  symbol: string
  name: string | null
  price: number
  m6: number // 6-month return %, skip-month
  m3: number
  score: number
  avgTurnoverCr: number
  earnings: 'improving' | 'deteriorating' | 'mixed' | null // null = not studied yet
  qualityTier: string | null
  fact: string
}

export interface MomentumBoard {
  asOf: string | null
  entries: MomentumEntry[]
  scanned: number
  eligible: number
  note: string
}

let cache: { key: string; board: MomentumBoard } | null = null

export async function computeMomentumBoard(): Promise<MomentumBoard> {
  const latestDates = await pricesRepo.distinctRecentDates(1)
  const asOf = latestDates[0] ?? null
  if (asOf && cache?.key === asOf) return cache.board

  const instruments = await instrumentsRepo.listSymbolName()
  const candidates: Omit<MomentumEntry, 'rank' | 'earnings' | 'qualityTier' | 'fact'>[] = []
  let scanned = 0
  for (const inst of instruments) {
    // deep history is required for the 6-month window; names not yet backfilled are
    // skipped and counted, so the note can say how much of the universe is covered.
    const closes = await histRepo.closesAsc(inst.symbol).catch(() => [])
    if (closes.length < W6 + SKIP + 1) continue
    scanned++
    const last = closes[closes.length - 1]
    if (asOf && last.date < addDaysIso(asOf, -10)) continue // stale series — don't rank on old data
    const ref = closes[closes.length - 1 - SKIP] // "now", one month ago (skip window)
    const back6 = closes[closes.length - 1 - SKIP - W6]
    const back3 = closes[closes.length - 1 - SKIP - W3]
    if (!ref || !back6 || !back3 || back6.close <= 0 || back3.close <= 0) continue
    const m6 = round2(((ref.close - back6.close) / back6.close) * 100)
    const m3 = round2(((ref.close - back3.close) / back3.close) * 100)

    // liquidity from the live store (recent window, volume × close)
    const recent = await pricesRepo.recentClosesDesc(inst.symbol, 1)
    const bars = await pricesRepo.equityRows(inst.symbol).catch(() => [])
    const lastBars = bars.slice(-20)
    const turnover = lastBars.length ? lastBars.reduce((s, b) => s + b.close * b.volume, 0) / lastBars.length / 1e7 : 0
    if (turnover < MIN_TURNOVER_CR) continue

    candidates.push({
      symbol: inst.symbol,
      name: inst.name,
      price: recent[0]?.close ?? last.close,
      m6,
      m3,
      score: round2(0.6 * m6 + 0.4 * m3),
      avgTurnoverCr: round2(turnover),
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, TOP_N * 2) // overselect, then quality-gate down

  const entries: MomentumEntry[] = []
  for (const c of top) {
    if (entries.length >= TOP_N) break
    const fund = await fundRepo.get<Fundamentals>(c.symbol).catch(() => null)
    if (fund?.json?.risk?.forceAvoid) continue // quality gate: fundamentals scream avoid
    const res = await resultsRepo.get<ResultsTrend>(c.symbol).catch(() => null)
    const earnings = res?.json?.direction ?? null
    entries.push({
      ...c,
      rank: entries.length + 1,
      earnings,
      qualityTier: fund?.json?.qualityTier ?? null,
      fact: `6m ${c.m6 >= 0 ? '+' : ''}${c.m6}% · 3m ${c.m3 >= 0 ? '+' : ''}${c.m3}% (both to ~1 month ago, recent month skipped) — our stored daily closes${earnings ? `; quarterly profit trend ${earnings} (screener.in)` : ''}`,
    })
  }

  const board: MomentumBoard = {
    asOf,
    entries,
    scanned,
    eligible: candidates.length,
    note:
      `Ranked ${candidates.length} liquid names (of ${scanned} with ≥6m deep history; universe ${instruments.length}) by 0.6×6m + 0.4×3m return, recent month skipped, min ₹${MIN_TURNOVER_CR}cr/day turnover, fundamentals force-avoid names cut. ` +
      `Re-ranks each session but is MEANT to be acted on monthly — churning it daily throws away the edge. Momentum + improving earnings is the strongest bucket; momentum with deteriorating earnings is historically a trap.`,
  }
  if (asOf) cache = { key: asOf, board }
  return board
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
