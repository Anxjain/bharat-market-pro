// Repository: fact_sheets (screener.in cached sheets) + staleness helpers.
import { eq, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { factSheets, instruments } from '../db/schema'

export async function get(symbol: string): Promise<{ json: string; updatedAt: string } | null> {
  const rows = await db
    .select({ json: factSheets.json, updatedAt: factSheets.updatedAt })
    .from(factSheets)
    .where(eq(factSheets.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

export async function upsert(symbol: string, json: string, updatedAt: string): Promise<void> {
  await db
    .insert(factSheets)
    .values({ symbol, json, updatedAt })
    .onConflictDoUpdate({
      target: factSheets.symbol,
      set: { json: sql`excluded.json`, updatedAt: sql`excluded.updated_at` },
    })
}

/** Symbols whose fact sheet is stalest or never fetched — never-fetched FIRST.
 *  H-21: in Postgres `false < true`, so `(updatedAt is null) asc` put rows that ALREADY
 *  had a sheet ahead of the never-fetched ones — a new NIFTY500 constituent waited a day+
 *  for its logo/sheet. `desc` puts nulls (never fetched) first, then oldest updatedAt. */
export async function staleSymbols(limit: number): Promise<string[]> {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .leftJoin(factSheets, eq(factSheets.symbol, instruments.symbol))
    .orderBy(sql`(${factSheets.updatedAt} is null) desc`, asc(factSheets.updatedAt))
    .limit(limit)
  return rows.map((r) => r.symbol)
}

export async function freshList(): Promise<{ symbol: string; updatedAt: string }[]> {
  return db.select({ symbol: factSheets.symbol, updatedAt: factSheets.updatedAt }).from(factSheets)
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(factSheets)
  return rows[0]?.n ?? 0
}
