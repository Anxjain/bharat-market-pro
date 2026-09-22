// Repository: guidance signal snapshots (audit cache of computed recommendations).
import { eq, desc, gte } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceSnapshots } from '../db/schema'

export interface SnapshotInput {
  symbol: string
  asOf: string
  dataDate: string | null
  score: number | null
  tier: string | null
  factors: unknown
  baserate: unknown
  analyst: unknown
}

export async function insert(s: SnapshotInput): Promise<void> {
  await db.insert(guidanceSnapshots).values({
    symbol: s.symbol.toUpperCase(),
    asOf: s.asOf,
    dataDate: s.dataDate,
    score: s.score,
    tier: s.tier,
    factors: s.factors,
    baserate: s.baserate,
    analyst: s.analyst,
  })
}

/** All snapshots (lean columns) — the substrate for the track-record / calibration. */
export async function all(): Promise<{ symbol: string; asOf: string; dataDate: string | null; score: number | null; tier: string | null }[]> {
  return db
    .select({ symbol: guidanceSnapshots.symbol, asOf: guidanceSnapshots.asOf, dataDate: guidanceSnapshots.dataDate, score: guidanceSnapshots.score, tier: guidanceSnapshots.tier })
    .from(guidanceSnapshots)
    .orderBy(desc(guidanceSnapshots.asOf))
}

/** Lean snapshots at/after a cutoff — the conviction-accrual window (how has each name's
 *  score moved across the last few daily studies?). */
export async function since(cutoffIso: string): Promise<{ symbol: string; asOf: string; score: number | null; tier: string | null }[]> {
  return db
    .select({ symbol: guidanceSnapshots.symbol, asOf: guidanceSnapshots.asOf, score: guidanceSnapshots.score, tier: guidanceSnapshots.tier })
    .from(guidanceSnapshots)
    .where(gte(guidanceSnapshots.asOf, cutoffIso))
    .orderBy(desc(guidanceSnapshots.asOf))
}

export async function latest(symbol: string): Promise<typeof guidanceSnapshots.$inferSelect | null> {
  const rows = await db
    .select()
    .from(guidanceSnapshots)
    .where(eq(guidanceSnapshots.symbol, symbol.toUpperCase()))
    .orderBy(desc(guidanceSnapshots.asOf))
    .limit(1)
  return rows[0] ?? null
}

/**
 * M-G5: insert a snapshot at most ONCE per symbol per UTC day. computeSignal runs on
 * every board deep-score and watchlist pass, so an unthrottled insert would flood the
 * audit table; one row per name per day is enough substrate for calibration/track-record.
 * Returns true when a row was actually written.
 */
export async function insertDaily(s: SnapshotInput): Promise<boolean> {
  const last = await latest(s.symbol)
  if (last?.asOf && last.asOf.slice(0, 10) === s.asOf.slice(0, 10)) return false
  await insert(s)
  return true
}
