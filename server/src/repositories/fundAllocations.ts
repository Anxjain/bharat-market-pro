// Repository: fund_allocations (asset / sector weights + F&U mandate bands).
import { and, eq, sql } from 'drizzle-orm'
import { db, type DB } from '../db/client'
import { fundAllocations } from '../db/schema'

// Executor = the shared db OR a transaction handle, so a caller can thread a `tx`.
type Exec = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

export interface FundAllocationRow {
  sfin: string
  month: string
  kind: string // 'asset' | 'sector' | 'fnu'
  label: string
  weight: number | null
  fuMin: number | null
  fuMax: number | null
}

export async function upsertMany(rows: FundAllocationRow[], exec: Exec = db): Promise<number> {
  if (rows.length === 0) return 0
  // Dedupe by conflict key (a factsheet can repeat a sector/asset label) — Postgres
  // rejects a batch whose ON CONFLICT target appears twice. Keep last occurrence.
  const deduped = [...new Map(rows.map((r) => [`${r.sfin}|${r.month}|${r.kind}|${r.label}`, r])).values()]
  await exec
    .insert(fundAllocations)
    .values(deduped)
    .onConflictDoUpdate({
      target: [fundAllocations.sfin, fundAllocations.month, fundAllocations.kind, fundAllocations.label],
      set: { weight: sql`excluded.weight`, fuMin: sql`excluded.fu_min`, fuMax: sql`excluded.fu_max` },
    })
  return deduped.length
}

export async function getForFund(sfin: string, month: string): Promise<FundAllocationRow[]> {
  return db.select().from(fundAllocations).where(and(eq(fundAllocations.sfin, sfin), eq(fundAllocations.month, month)))
}

/** Remove all allocation rows for a fund/month — call before re-inserting (clean re-extraction). */
export async function deleteByFundMonth(sfin: string, month: string, exec: Exec = db): Promise<void> {
  await exec.delete(fundAllocations).where(and(eq(fundAllocations.sfin, sfin), eq(fundAllocations.month, month)))
}
