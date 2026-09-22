// Repository: prices (equity EOD OHLCV).
import { eq, and, asc, desc, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { prices, instruments } from '../db/schema'

export interface PriceRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export async function equityRows(symbol: string): Promise<PriceRow[]> {
  return db
    .select({ date: prices.date, open: prices.open, high: prices.high, low: prices.low, close: prices.close, volume: prices.volume })
    .from(prices)
    .where(eq(prices.symbol, symbol))
    .orderBy(asc(prices.date))
}

/** (date, close) ascending — for risk/stat windows. */
export async function closesAsc(symbol: string): Promise<{ date: string; close: number }[]> {
  return db.select({ date: prices.date, close: prices.close }).from(prices).where(eq(prices.symbol, symbol)).orderBy(asc(prices.date))
}

/** (date, close) most-recent-first, capped — for quick day/month deltas. */
export async function recentClosesDesc(symbol: string, limit: number): Promise<{ date: string; close: number }[]> {
  return db
    .select({ date: prices.date, close: prices.close })
    .from(prices)
    .where(eq(prices.symbol, symbol))
    .orderBy(desc(prices.date))
    .limit(limit)
}

export async function distinctRecentDates(limit: number): Promise<string[]> {
  const rows = await db.selectDistinct({ date: prices.date }).from(prices).orderBy(desc(prices.date)).limit(limit)
  return rows.map((r) => r.date)
}

export interface UniverseJoinRow {
  symbol: string
  name: string
  industry: string
  domain: string | null
  close: number | null
  prevClose: number | null
}

/** Full universe with latest + previous session close (LEFT JOINs on two dates). */
export async function universe(last: string, prev: string): Promise<UniverseJoinRow[]> {
  const p1 = alias(prices, 'p1')
  const p0 = alias(prices, 'p0')
  return db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      industry: instruments.industry,
      domain: instruments.domain,
      close: p1.close,
      prevClose: p0.close,
    })
    .from(instruments)
    .leftJoin(p1, and(eq(p1.symbol, instruments.symbol), eq(p1.date, last)))
    .leftJoin(p0, and(eq(p0.symbol, instruments.symbol), eq(p0.date, prev)))
    .orderBy(asc(instruments.symbol))
}

export interface SessionRow {
  symbol: string
  name: string
  open: number | null
  close: number | null
  prevClose: number | null
}

/** Per-symbol open/close for `last` session + prior close — for movers/ranking. */
export async function sessionRows(last: string, prev: string): Promise<SessionRow[]> {
  const p1 = alias(prices, 'p1')
  const p0 = alias(prices, 'p0')
  return db
    .select({ symbol: instruments.symbol, name: instruments.name, open: p1.open, close: p1.close, prevClose: p0.close })
    .from(instruments)
    .leftJoin(p1, and(eq(p1.symbol, instruments.symbol), eq(p1.date, last)))
    .leftJoin(p0, and(eq(p0.symbol, instruments.symbol), eq(p0.date, prev)))
}

export async function upsertPrices(
  rows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(prices)
    .values(rows)
    .onConflictDoUpdate({
      target: [prices.symbol, prices.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        volume: sql`excluded.volume`,
      },
    })
  return rows.length
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(prices)
  return rows[0]?.n ?? 0
}

/** Bulk-set delivery % on existing (symbol, date) rows — one statement, not N updates.
 *  Rows without a matching price bar are ignored (delivery file covers more series). */
export async function updateDelivery(rows: { symbol: string; date: string; delivPct: number }[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.execute(sql`
    UPDATE prices p SET deliv_pct = v.dp
    FROM (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(symbol text, date text, "delivPct" double precision)) v(symbol, date, dp)
    WHERE p.symbol = v.symbol AND p.date = v.date
  `)
  return rows.length
}

/** Full OHLC bars for one symbol STRICTLY AFTER a date, ascending — the paper-trading
 *  stop-loss/target sweep replays these bars gap-aware (fills at open on a gap). */
export async function barsAfter(symbol: string, date: string): Promise<PriceRow[]> {
  return db
    .select({ date: prices.date, open: prices.open, high: prices.high, low: prices.low, close: prices.close, volume: prices.volume })
    .from(prices)
    .where(and(eq(prices.symbol, symbol), sql`${prices.date} > ${date}`))
    .orderBy(asc(prices.date))
}

/** All (symbol, date, close, volume) since a date — for the universe-wide opportunity scan. */
export async function since(date: string): Promise<{ symbol: string; date: string; close: number; volume: number }[]> {
  return db
    .select({ symbol: prices.symbol, date: prices.date, close: prices.close, volume: prices.volume })
    .from(prices)
    .where(sql`${prices.date} >= ${date}`)
    .orderBy(asc(prices.symbol), asc(prices.date))
}
