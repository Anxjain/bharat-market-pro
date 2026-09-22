// Repository: index_prices (index EOD closes).
import { asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { indexPrices } from '../db/schema'

export interface IndexCandleRow {
  date: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** Candle rows for one index; missing OHLC fall back to close (matches prior SQL). */
export async function indexRows(name: string): Promise<IndexCandleRow[]> {
  return db
    .select({
      date: indexPrices.date,
      o: sql<number>`coalesce(${indexPrices.open}, ${indexPrices.close})`,
      h: sql<number>`coalesce(${indexPrices.high}, ${indexPrices.close})`,
      l: sql<number>`coalesce(${indexPrices.low}, ${indexPrices.close})`,
      c: indexPrices.close,
      v: sql<number>`0`,
    })
    .from(indexPrices)
    .where(sql`lower(${indexPrices.name}) = lower(${name})`)
    .orderBy(asc(indexPrices.date))
}

export async function upsertIndexPrices(
  rows: { name: string; date: string; open: number | null; high: number | null; low: number | null; close: number }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(indexPrices)
    .values(rows)
    .onConflictDoUpdate({
      target: [indexPrices.name, indexPrices.date],
      set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close` },
    })
  return rows.length
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(indexPrices)
  return rows[0]?.n ?? 0
}

