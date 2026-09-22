// Repository: persisted opportunity-scan boards (one row per run).
import { desc, gte } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceBoard } from '../db/schema'

export async function save(asOf: string, json: unknown): Promise<void> {
  await db.insert(guidanceBoard).values({ asOf, json, createdAt: new Date().toISOString() }).onConflictDoNothing()
}

export async function latest<T = unknown>(): Promise<{ asOf: string; json: T } | null> {
  const rows = await db.select().from(guidanceBoard).orderBy(desc(guidanceBoard.createdAt)).limit(1)
  return rows[0] ? { asOf: rows[0].asOf, json: rows[0].json as T } : null
}

export async function recent<T = unknown>(n: number): Promise<{ asOf: string; json: T }[]> {
  const rows = await db.select().from(guidanceBoard).orderBy(desc(guidanceBoard.createdAt)).limit(n)
  return rows.map((r) => ({ asOf: r.asOf, json: r.json as T }))
}

/** All scan boards created at/after an ISO cutoff (newest first) — for the weekly
 *  aggregate, which needs every scan inside the window rather than a fixed count. */
export async function since<T = unknown>(cutoffIso: string): Promise<{ asOf: string; json: T }[]> {
  const rows = await db
    .select()
    .from(guidanceBoard)
    .where(gte(guidanceBoard.createdAt, cutoffIso))
    .orderBy(desc(guidanceBoard.createdAt))
    .limit(500)
  return rows.map((r) => ({ asOf: r.asOf, json: r.json as T }))
}
