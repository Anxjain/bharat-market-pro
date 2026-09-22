// Repository: cached quarterly/annual results trend per symbol (DB-persisted so it
// accumulates and isn't re-scraped on every view).
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceResults } from '../db/schema'

export async function get<T = unknown>(symbol: string): Promise<{ json: T; updatedAt: string } | null> {
  const rows = await db.select().from(guidanceResults).where(eq(guidanceResults.symbol, symbol.toUpperCase())).limit(1)
  return rows[0] ? { json: rows[0].json as T, updatedAt: rows[0].updatedAt } : null
}

export async function set(symbol: string, json: unknown): Promise<void> {
  await db
    .insert(guidanceResults)
    .values({ symbol: symbol.toUpperCase(), json, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: guidanceResults.symbol, set: { json: sql`excluded.json`, updatedAt: sql`excluded.updated_at` } })
}
