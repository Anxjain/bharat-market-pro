// Repository: quotes_history (append-only delayed-quote captures).
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { quotesHistory } from '../db/schema'

export interface QuoteInsert {
  symbol: string
  price: number
  changePct: number | null
  ts: string
}

export async function insertMany(rows: QuoteInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(quotesHistory).values(rows)
  return rows.length
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(quotesHistory)
  return rows[0]?.n ?? 0
}

/** M-B4: prune captures older than `days` (ts is ISO text → lexicographic compare is
 *  chronological). Parameterized cutoff; returns rows removed. */
export async function pruneOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const res = await db.delete(quotesHistory).where(sql`${quotesHistory.ts} < ${cutoff}`)
  return (res as unknown as { rowCount?: number | null }).rowCount ?? 0
}
