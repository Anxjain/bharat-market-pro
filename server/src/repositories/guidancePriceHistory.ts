// Repository: deep daily price history (multi-year) for base-rate computation.
import { eq, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidancePriceHistory } from '../db/schema'

export interface Candle {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
}

export async function closesAsc(symbol: string): Promise<{ date: string; close: number }[]> {
  return db
    .select({ date: guidancePriceHistory.date, close: guidancePriceHistory.close })
    .from(guidancePriceHistory)
    .where(eq(guidancePriceHistory.symbol, symbol))
    .orderBy(asc(guidancePriceHistory.date))
}

export async function candlesAsc(symbol: string): Promise<Candle[]> {
  return db
    .select({
      date: guidancePriceHistory.date,
      open: guidancePriceHistory.open,
      high: guidancePriceHistory.high,
      low: guidancePriceHistory.low,
      close: guidancePriceHistory.close,
      volume: guidancePriceHistory.volume,
    })
    .from(guidancePriceHistory)
    .where(eq(guidancePriceHistory.symbol, symbol))
    .orderBy(asc(guidancePriceHistory.date))
}

export async function count(symbol: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(guidancePriceHistory)
    .where(eq(guidancePriceHistory.symbol, symbol))
  return rows[0]?.n ?? 0
}

/** The most recent stored date for a symbol (YYYY-MM-DD), or null when empty.
 *  Used by CR-7 to decide whether the tail of the series is stale and needs an
 *  incremental refetch. */
export async function latestDate(symbol: string): Promise<string | null> {
  const rows = await db
    .select({ d: sql<string | null>`max(${guidancePriceHistory.date})` })
    .from(guidancePriceHistory)
    .where(eq(guidancePriceHistory.symbol, symbol))
  return rows[0]?.d ?? null
}

export async function symbolsWithData(): Promise<string[]> {
  const rows = await db.selectDistinct({ symbol: guidancePriceHistory.symbol }).from(guidancePriceHistory)
  return rows.map((r) => r.symbol)
}

export async function upsertMany(
  symbol: string,
  rows: { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }[],
  source = 'yahoo',
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((r) => ({ symbol: symbol.toUpperCase(), ...r, source }))
  // Chunk to stay well under Postgres' parameter ceiling (8 cols × rows).
  const CHUNK = 1000
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(guidancePriceHistory)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [guidancePriceHistory.symbol, guidancePriceHistory.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          source: sql`excluded.source`,
        },
      })
  }
  return values.length
}
