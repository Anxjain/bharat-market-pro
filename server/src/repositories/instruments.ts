// Repository: instruments (NIFTY 500 master).
import { eq, asc, sql, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { instruments } from '../db/schema'

export interface InstrumentRow {
  symbol: string
  name: string
  industry: string
  domain: string | null
}

export async function getInstrument(symbol: string): Promise<InstrumentRow | null> {
  const rows = await db
    .select({ symbol: instruments.symbol, name: instruments.name, industry: instruments.industry, domain: instruments.domain })
    .from(instruments)
    .where(eq(instruments.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

export async function getSymbolName(symbol: string): Promise<{ symbol: string; name: string } | null> {
  const rows = await db
    .select({ symbol: instruments.symbol, name: instruments.name })
    .from(instruments)
    .where(eq(instruments.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

export async function instrumentExists(symbol: string): Promise<boolean> {
  const rows = await db.select({ symbol: instruments.symbol }).from(instruments).where(eq(instruments.symbol, symbol)).limit(1)
  return rows.length > 0
}

/** All (symbol, name) pairs, ordered by symbol — used for alias/lookup tables. */
export async function listSymbolName(): Promise<{ symbol: string; name: string }[]> {
  return db.select({ symbol: instruments.symbol, name: instruments.name }).from(instruments).orderBy(asc(instruments.symbol))
}

export async function listSymbols(): Promise<string[]> {
  const rows = await db.select({ symbol: instruments.symbol }).from(instruments)
  return rows.map((r) => r.symbol)
}

export async function upsertInstruments(
  rows: { symbol: string; name: string; industry: string; isin: string | null }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(instruments)
    .values(rows)
    .onConflictDoUpdate({
      target: instruments.symbol,
      set: { name: sql`excluded.name`, industry: sql`excluded.industry`, isin: sql`excluded.isin` },
    })
  return rows.length
}

export async function setDomain(symbol: string, domain: string): Promise<void> {
  await db.update(instruments).set({ domain }).where(eq(instruments.symbol, symbol))
}

export async function countWithDomain(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(instruments).where(isNotNull(instruments.domain))
  return rows[0]?.n ?? 0
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(instruments)
  return rows[0]?.n ?? 0
}
