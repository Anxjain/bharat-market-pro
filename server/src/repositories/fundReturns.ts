// Repository: fund_returns (trailing returns vs benchmark, one row per period).
import { and, eq, sql } from 'drizzle-orm'
import { db, type DB } from '../db/client'
import { fundReturns } from '../db/schema'

// Executor = the shared db OR a transaction handle, so a caller can thread a `tx`.
type Exec = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

export interface FundReturnRow {
  sfin: string
  month: string
  period: string
  returnPct: number | null
  benchmarkPct: number | null
}

export async function upsertMany(rows: FundReturnRow[], exec: Exec = db): Promise<number> {
  if (rows.length === 0) return 0
  // Dedupe by conflict key (a doc/extractor can repeat a period) — Postgres rejects
  // a batch whose ON CONFLICT target appears twice. Keep last occurrence.
  const deduped = [...new Map(rows.map((r) => [`${r.sfin}|${r.month}|${r.period}`, r])).values()]
  await exec
    .insert(fundReturns)
    .values(deduped)
    .onConflictDoUpdate({
      target: [fundReturns.sfin, fundReturns.month, fundReturns.period],
      set: { returnPct: sql`excluded.return_pct`, benchmarkPct: sql`excluded.benchmark_pct` },
    })
  return deduped.length
}

export async function getForFund(sfin: string, month: string): Promise<FundReturnRow[]> {
  return db.select().from(fundReturns).where(and(eq(fundReturns.sfin, sfin), eq(fundReturns.month, month)))
}

/** Remove all return rows for a fund/month — call before re-inserting (clean re-extraction). */
export async function deleteByFundMonth(sfin: string, month: string, exec: Exec = db): Promise<void> {
  await exec.delete(fundReturns).where(and(eq(fundReturns.sfin, sfin), eq(fundReturns.month, month)))
}

/** All return rows for a month (bulk) — used to enrich the chat catalog in one query. */
export async function getMonthReturns(month: string): Promise<FundReturnRow[]> {
  return db.select().from(fundReturns).where(eq(fundReturns.month, month))
}
