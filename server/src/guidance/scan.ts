// Opportunity scanner — the always-on side of the desk.
//
// Instead of only scoring a name when you click it, this scans the whole universe on a
// schedule and produces a ranked board of the highest-probability setups ("best today"),
// plus today's notable movers. Tiered so 500 names are feasible:
//   1. CHEAP pre-screen over every symbol from the local price store → candidates
//      (sharp drops with bounce potential + strong risers) and movers.
//   2. DEEP-score the top candidates with the full engine (factors + base rate + news /
//      filings / earnings + verdict).
//   3. Rank by the evidence-backed score, persist the board (accumulates for "this week").
import * as pricesRepo from '../repositories/prices'
import { listSymbolName } from '../repositories/instruments'
import { ensureHistory } from './history'
import { computeSignal, type Signal } from './signal'
import * as boardRepo from '../repositories/guidanceBoard'
import * as watchRepo from '../repositories/guidanceWatchlist'
import * as snapshotsRepo from '../repositories/guidanceSnapshots'

/** Map raw watchlist tags → the owner's headline themes (banks / renewables / energy). */
export function themesFromTags(tags: string[]): string[] {
  const t = new Set(tags.map((x) => x.toLowerCase()))
  const out: string[] = []
  if (t.has('bank') || t.has('financials')) out.push('banks')
  if (t.has('renewables') || t.has('solar') || t.has('wind')) out.push('renewables')
  if (t.has('energy') || t.has('oilgas') || t.has('utility')) out.push('energy')
  return out
}

export interface Mover {
  symbol: string
  name: string | null
  move1d: number // %
}
export type SetupType = 'dip' | 'rise' | 'trend' | 'watch'
export interface Opportunity {
  rank: number
  symbol: string
  name: string | null
  type: SetupType // dip/rise = day movers; trend = steady uptrend near highs; watch = watchlist daily study
  score: number
  tier: Signal['tier']
  verdict: string
  reasons: { tone: string; text: string }[]
  odds: string
  price: number | null
  move1d: number | null
  move5d: number | null
  cappedByRisk: boolean
  deep: boolean
  qualityScore: number | null // business-quality axis (separate from the timing score above)
  qualityTier: string | null
  qualityAvoid: boolean // fundamentals force a "do not recommend"
  themes: string[] // owner focus themes (banks / renewables / energy) from the watchlist tags
  daysSeen?: number // "this week" aggregate only: how many of the week's scans it appeared in
  // Conviction accrual: the desk studies these names daily; a setup that persists and
  // IMPROVES across days is more trustworthy than a one-day flash.
  daysStudied?: number // distinct days with a stored signal in the last week (incl. today)
  scoreDelta?: number | null // today's score − the previous study's score
  // #5: the odds turned into a decision aid (null when no active dip/pop setup).
  expectancy?: { evPer100: number; horizon: number; winRate: number; size: string } | null
}
export interface Board {
  asOf: string
  scanned: number
  deepScored: number
  buys: Opportunity[] // the explicit daily buy list (constructive+, no red flags, positive edge)
  opportunities: Opportunity[]
  risers: Mover[]
  fallers: Mover[]
  note: string
}

interface Candidate {
  symbol: string
  type: SetupType
  move1d: number
  move5d: number
}

function rsiQuick(c: number[], n = 14): number | null {
  if (c.length < n + 1) return null
  let g = 0
  let l = 0
  for (let i = c.length - n; i < c.length; i++) {
    const d = c[i] - c[i - 1]
    if (d >= 0) g += d
    else l -= d
  }
  if (g + l === 0) return 50
  return 100 - 100 / (1 + g / (l || 1e-9))
}
const pc = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/** Cheap, universe-wide pre-screen from the local price store. */
async function prescreen(): Promise<{ candidates: Candidate[]; risers: Mover[]; fallers: Mover[]; scanned: number; moveBySym: Map<string, { move1d: number; move5d: number }> }> {
  const dates = await pricesRepo.distinctRecentDates(45)
  if (dates.length < 6) return { candidates: [], risers: [], fallers: [], scanned: 0, moveBySym: new Map() }
  const rows = await pricesRepo.since(dates[dates.length - 1])
  const nameBySym = new Map((await listSymbolName()).map((r) => [r.symbol, r.name]))

  const by = new Map<string, { close: number; volume: number }[]>()
  for (const r of rows) {
    const arr = by.get(r.symbol) ?? []
    if (!by.has(r.symbol)) by.set(r.symbol, arr)
    arr.push({ close: r.close, volume: r.volume })
  }

  const dips: { c: Candidate; score: number }[] = []
  const rises: { c: Candidate; score: number }[] = []
  const trends: { c: Candidate; score: number }[] = []
  const moves: Mover[] = []
  const moveBySym = new Map<string, { move1d: number; move5d: number }>()
  let scanned = 0

  for (const [symbol, series] of by) {
    if (series.length < 20) continue
    const c = series.map((s) => s.close)
    const v = series.map((s) => s.volume)
    const px = c[c.length - 1]
    const prev = c[c.length - 2]
    if (!px || !prev) continue
    scanned++
    const move1d = pc(px, prev)
    const move5d = c.length > 6 ? pc(px, c[c.length - 6]) : 0
    const move20d = c.length > 21 ? pc(px, c[c.length - 21]) : 0
    const high = Math.max(...c)
    const ddFromHigh = pc(px, high)
    const rsi = rsiQuick(c)
    const avg20v = v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length)
    const volSpike = avg20v ? v[v.length - 1] / avg20v : 1
    const liqCr = (avg20v * px) / 1e7
    moves.push({ symbol, name: nameBySym.get(symbol) ?? null, move1d: round2(move1d) })
    moveBySym.set(symbol, { move1d: round2(move1d), move5d: round2(move5d) })
    if (liqCr < 5) continue // skip illiquid for actionable ideas

    // Dip-buy setup: oversold + recent drop, but not a bottomless structural crash.
    let dipScore = 0
    if (rsi != null) dipScore += rsi < 30 ? 2 : rsi < 40 ? 1 : 0
    dipScore += move1d < -4 ? 2 : move1d < -2 ? 1 : 0
    dipScore += move5d < -6 ? 1.5 : 0
    if (ddFromHigh < -8 && ddFromHigh > -45) dipScore += 1
    if (dipScore >= 2) dips.push({ c: { symbol, type: 'dip', move1d: round2(move1d), move5d: round2(move5d) }, score: dipScore })

    // Momentum / breakout: rising on volume, uptrend intact.
    let riseScore = 0
    riseScore += move1d > 4 ? 2 : move1d > 2 ? 1 : 0
    riseScore += move5d > 6 ? 2 : move5d > 3 ? 1 : 0
    riseScore += move20d > 0 ? 1 : 0
    riseScore += volSpike > 1.5 ? 1 : 0
    if (riseScore >= 3) rises.push({ c: { symbol, type: 'rise', move1d: round2(move1d), move5d: round2(move5d) }, score: riseScore })

    // Steady-trend setup: names compounding QUIETLY near their highs never post a ±4%
    // day, so the mover screens above are blind to them — the classic "the best name
    // never showed up on the board" gap. Sustained 20d gain, sitting near the window
    // high, no active slide. The deep-score stage judges the rest (200-DMA, quality…).
    if (!(dipScore >= 2) && !(riseScore >= 3)) {
      let trendScore = 0
      trendScore += move20d > 8 ? 2 : move20d > 4 ? 1 : 0
      trendScore += ddFromHigh > -3.5 ? 1.5 : 0 // within ~3.5% of the 45-session high
      trendScore += move5d >= -1 ? 0.5 : 0
      trendScore += volSpike > 1.1 ? 0.5 : 0
      if (trendScore >= 3) trends.push({ c: { symbol, type: 'trend', move1d: round2(move1d), move5d: round2(move5d) }, score: trendScore })
    }
  }

  dips.sort((a, b) => b.score - a.score)
  rises.sort((a, b) => b.score - a.score)
  trends.sort((a, b) => b.score - a.score)
  // Candidate set: best dip setups + best risers + best steady trends (dip preferred on overlap).
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const d of dips.slice(0, 18)) if (!seen.has(d.c.symbol)) { seen.add(d.c.symbol); candidates.push(d.c) }
  for (const r of rises.slice(0, 10)) if (!seen.has(r.c.symbol)) { seen.add(r.c.symbol); candidates.push(r.c) }
  for (const t of trends.slice(0, 10)) if (!seen.has(t.c.symbol)) { seen.add(t.c.symbol); candidates.push(t.c) }

  moves.sort((a, b) => b.move1d - a.move1d)
  return { candidates, risers: moves.slice(0, 8), fallers: moves.slice(-8).reverse(), scanned, moveBySym }
}

let scanning = false
export function isScanning(): boolean {
  return scanning
}

/** Fire a scan in the background (no concurrent runs). */
export function triggerScan(opts: { deepN?: number } = {}): boolean {
  if (scanning) return false
  scanning = true
  runScan(opts)
    .catch((e) => console.warn('[guidance:scan] failed:', (e as Error).message))
    .finally(() => { scanning = false })
  return true
}

/** Run a full scan: pre-screen → deep-score watchlist + top candidates → rank → persist. */
export async function runScan(opts: { deepN?: number } = {}): Promise<Board> {
  const asOf = new Date().toISOString()
  const { candidates, risers, fallers, scanned, moveBySym } = await prescreen()
  const deepN = opts.deepN ?? 60
  const watch = await watchRepo.list(true)
  // Owner focus themes per symbol (banks / renewables / energy) from the watchlist tags.
  const themeBySym = new Map(watch.map((w) => [w.symbol, themesFromTags(w.tags)]))

  // The desk STUDIES the whole watchlist every day — not just whatever moved sharply.
  // Watchlist names come first (they're the owner's focus and are how signal history
  // accrues for the track record), then the universe movers/trends up to deepN.
  const picked: Candidate[] = []
  const seen = new Set<string>()
  for (const w of watch) {
    const mv = moveBySym.get(w.symbol) ?? { move1d: 0, move5d: 0 }
    const type: SetupType = mv.move1d <= -2 ? 'dip' : mv.move1d >= 2 ? 'rise' : 'watch'
    seen.add(w.symbol)
    picked.push({ symbol: w.symbol, type, move1d: mv.move1d, move5d: mv.move5d })
  }
  for (const c of candidates) {
    if (picked.length >= deepN) break
    if (!seen.has(c.symbol)) { seen.add(c.symbol); picked.push(c) }
  }

  const opps: Opportunity[] = []
  for (let idx = 0; idx < picked.length; idx++) {
    const cand = picked[idx]
    try {
      // M-G8: deep-scoring each candidate triggers live screener + Yahoo fetches. Space them
      // out (≥600ms) so a cold scan doesn't fire ~50-70 screener requests/min and trip a
      // rate-limit/ban. (fundamentals.ts/results.ts also back off on 429; fundamentals and
      // deep history are cached, so the steady-state daily cost is far below the cold cost.)
      if (idx > 0) await new Promise((r) => setTimeout(r, 600))
      await ensureHistory(cand.symbol).catch(() => {})
      const sig = await computeSignal(cand.symbol, { fetchIfMissing: true })
      opps.push({
        rank: 0,
        symbol: sig.symbol,
        name: sig.name,
        type: cand.type,
        score: sig.score,
        tier: sig.tier,
        verdict: sig.readout.verdict,
        reasons: sig.readout.reasons.slice(0, 3).map((r) => ({ tone: r.tone, text: r.text })),
        odds: sig.readout.headline,
        price: sig.price,
        move1d: cand.move1d,
        move5d: cand.move5d,
        cappedByRisk: sig.cappedByRisk,
        deep: sig.deep,
        qualityScore: sig.quality?.qualityScore ?? null,
        qualityTier: sig.quality?.qualityTier ?? null,
        qualityAvoid: sig.quality?.risk.forceAvoid ?? false,
        themes: themeBySym.get(sig.symbol) ?? [],
        expectancy: sig.expectancy
          ? { evPer100: sig.expectancy.evPer100, horizon: sig.expectancy.horizon, winRate: sig.expectancy.winRate, size: sig.expectancy.size }
          : null,
      })
    } catch {
      /* skip a name that fails to score */
    }
  }

  // Conviction accrual: join the last week of daily signal snapshots. A name that has
  // been setting up for days with a RISING score is a stronger candidate than a one-day
  // flash — and a fading one gets no persistence credit.
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const snaps = await snapshotsRepo.since(cutoff)
    const bySym = new Map<string, { asOf: string; score: number | null }[]>()
    for (const s of snaps) {
      const a = bySym.get(s.symbol) ?? []
      a.push({ asOf: s.asOf, score: s.score })
      bySym.set(s.symbol, a)
    }
    const today = asOf.slice(0, 10)
    for (const o of opps) {
      const rows = bySym.get(o.symbol) ?? [] // newest first (repo orders desc)
      o.daysStudied = new Set(rows.map((r) => r.asOf.slice(0, 10))).size || 1
      const prev = rows.find((r) => r.asOf.slice(0, 10) !== today && r.score != null)
      o.scoreDelta = prev?.score != null ? o.score - prev.score : null
    }
  } catch { /* accrual is best-effort — a fresh DB just means no history yet */ }

  // Rank by the TIMING score, but let business quality gate/tilt it (a fundamentals
  // "force-avoid" is pushed to the bottom, better businesses get a lift) and give a
  // small persistence bonus to improving multi-day setups.
  const qAdj = (o: Opportunity) => (o.qualityAvoid ? -100 : o.qualityTier === 'excellent' ? 8 : o.qualityTier === 'good' ? 4 : o.qualityTier === 'weak' ? -12 : 0)
  const pAdj = (o: Opportunity) => ((o.scoreDelta ?? 0) >= 3 && (o.daysStudied ?? 1) >= 2 ? 4 : 0) + ((o.daysStudied ?? 1) >= 3 && (o.scoreDelta ?? 0) >= 0 ? 2 : 0)
  opps.sort((a, b) => b.score + qAdj(b) + pAdj(b) - (a.score + qAdj(a) + pAdj(a)))
  opps.forEach((o, i) => (o.rank = i + 1))

  // The explicit DAILY BUY LIST: constructive-or-better verdicts with no fired red flag
  // and no negative measured edge, best expectancy first. This is the "what do I buy
  // today" answer; the full board below it is the evidence trail.
  const buys = opps
    .filter((o) => (o.tier === 'high-conviction' || o.tier === 'constructive') && !o.cappedByRisk && !o.qualityAvoid && (o.expectancy == null || o.expectancy.evPer100 > 0.5))
    .sort((a, b) => (b.expectancy?.evPer100 ?? 0) - (a.expectancy?.evPer100 ?? 0) || b.score - a.score)
    .slice(0, 8)

  const board: Board = {
    asOf,
    scanned,
    deepScored: opps.length,
    buys,
    opportunities: opps.slice(0, 30),
    risers,
    fallers,
    note: `Scanned ${scanned} names; studied all ${watch.length} watchlist names + the day's top movers and steady trends (${opps.length} deep-scored). Ranked by the evidence-backed setup score, with a persistence bonus for multi-day improving setups.`,
  }
  await boardRepo.save(asOf, board).catch(() => {})
  return board
}

/**
 * "This week" view — fold the last ~week of persisted scan boards into a single deduped
 * board. Each symbol keeps its BEST (highest-scored) appearance and a `daysSeen` count of
 * how many of the week's scans it showed up in (persistence across scans is itself a
 * signal). Movers are taken from the most recent scan. Returns null if no scans in-window.
 */
export async function weeklyBoard(days = 7): Promise<Board | null> {
  // (L) Fetch by createdAt >= cutoff (not a fixed row count) so a busy day of many scans
  // can't push the rest of the week out of a small LIMIT.
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString()
  const inWindow = await boardRepo.since<Board>(cutoffIso).catch(() => [])
  if (inWindow.length === 0) return null

  const best = new Map<string, Opportunity>()
  // (L) `daysSeen` must count DISTINCT scan DAYS a name appeared on, not the number of
  // scans — several rescans on one day shouldn't inflate the "durability" badge.
  const daysByS = new Map<string, Set<string>>()
  for (const b of inWindow) {
    const day = b.asOf.slice(0, 10)
    for (const o of b.json.opportunities ?? []) {
      if (!daysByS.has(o.symbol)) daysByS.set(o.symbol, new Set())
      daysByS.get(o.symbol)!.add(day)
      const prev = best.get(o.symbol)
      if (!prev || o.score > prev.score) best.set(o.symbol, o)
    }
  }
  const opportunities = [...best.values()]
    .map((o) => ({ ...o, daysSeen: daysByS.get(o.symbol)?.size ?? 1 }))
    .sort((a, b) => b.score - a.score)
    .map((o, i) => ({ ...o, rank: i + 1 }))

  const distinctDays = new Set(inWindow.map((b) => b.asOf.slice(0, 10))).size
  const latest = inWindow[0] // since() is newest-first
  return {
    asOf: latest.asOf,
    scanned: latest.json.scanned,
    deepScored: opportunities.length,
    buys: latest.json.buys ?? [], // the buy list is a TODAY decision — always the latest scan's
    opportunities: opportunities.slice(0, 24),
    risers: latest.json.risers ?? [],
    fallers: latest.json.fallers ?? [],
    note: `This week's aggregate — ${opportunities.length} distinct setups across ${inWindow.length} scans on ${distinctDays} day${distinctDays === 1 ? '' : 's'}, best score per name (“×n” = distinct days it appeared on; recurring names are the more durable setups).`,
  }
}
