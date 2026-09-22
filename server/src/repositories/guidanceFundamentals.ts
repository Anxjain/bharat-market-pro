// Repository: cached business fundamentals per symbol (DB-persisted).
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceFundamentals, guidanceFundamentalsHistory } from '../db/schema'

export async function get<T = unknown>(symbol: string): Promise<{ json: T; updatedAt: string } | null> {
  const rows = await db.select().from(guidanceFundamentals).where(eq(guidanceFundamentals.symbol, symbol.toUpperCase())).limit(1)
  return rows[0] ? { json: rows[0].json as T, updatedAt: rows[0].updatedAt } : null
}

export async function set(symbol: string, json: unknown): Promise<void> {
  await db
    .insert(guidanceFundamentals)
    .values({ symbol: symbol.toUpperCase(), json, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: guidanceFundamentals.symbol, set: { json: sql`excluded.json`, updatedAt: sql`excluded.updated_at` } })
}

// M-G6: `guidance_fundamentals` is keyed by symbol (upsert-overwrite), so each refresh
// destroys the prior snapshot. This appends every refresh to the append-only companion
// table so a real fundamentals time-series accumulates (substrate for later calibration).
// AUDIT FIX (2026-07-14): the table landed in migration 0012 and is a typed drizzle model
// now — swapped from the old raw-SQL insert (whose stale comment claimed the table was
// still owed).
export async function appendHistory(symbol: string, asOf: string, json: unknown): Promise<void> {
  await db.insert(guidanceFundamentalsHistory).values({
    symbol: symbol.toUpperCase(),
    asOf,
    json,
    createdAt: new Date().toISOString(),
  })
}
