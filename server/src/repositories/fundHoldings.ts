// Repository: fund_holdings (portfolio holdings, one row per security).
import { and, eq, isNull, asc, sql } from 'drizzle-orm'
import { db, type DB } from '../db/client'
import { fundHoldings } from '../db/schema'

// Executor = the shared db OR a transaction handle (both share the query builder), so
// callers can thread a `tx` from db.transaction(...) to make a multi-table write atomic.
type Exec = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

export interface FundHoldingRow {
  sfin: string
  month: string
  security: string
  weightPct: number | null
  normalizedSymbol: string | null
  category?: string | null
  rawCategory?: string | null
  isin?: string | null
  rating?: string | null
  marketValue?: number | null
}

export async function upsertMany(rows: FundHoldingRow[], exec: Exec = db): Promise<number> {
  if (rows.length === 0) return 0
  // Collapse duplicates within the batch (keep last) — Postgres rejects a batch whose
  // ON CONFLICT target appears twice ("cannot affect row a second time"). The key includes
  // category (one security can appear in two sections of a fund — e.g. equity + bond, each
  // with its own "Others" aggregate) AND isin: two distinct instruments (e.g. two G-Secs)
  // can print with the identical name+category but different ISINs and must NOT collapse.
  const deduped = [...new Map(rows.map((r) => [`${r.sfin}|${r.month}|${r.security}|${r.category ?? ''}|${r.isin ?? ''}`, r])).values()].map((r) => ({
    sfin: r.sfin, month: r.month, security: r.security, weightPct: r.weightPct, normalizedSymbol: r.normalizedSymbol,
    category: r.category ?? '', rawCategory: r.rawCategory ?? null, isin: r.isin ?? '',
    rating: r.rating ?? null, marketValue: r.marketValue ?? null,
  }))
  await exec
    .insert(fundHoldings)
    .values(deduped)
    // NOTE: conflict target includes isin to match the intended PK (sfin,month,security,category,isin).
    // This MUST ship together with the PK migration that adds `isin` — until then Postgres has no
    // unique constraint on these columns and the ON CONFLICT will error. (See report: PK needs isin.)
    .onConflictDoUpdate({
      target: [fundHoldings.sfin, fundHoldings.month, fundHoldings.security, fundHoldings.category, fundHoldings.isin],
      set: {
        weightPct: sql`excluded.weight_pct`, normalizedSymbol: sql`excluded.normalized_symbol`,
        category: sql`excluded.category`, rawCategory: sql`excluded.raw_category`,
        isin: sql`excluded.isin`, rating: sql`excluded.rating`, marketValue: sql`excluded.market_value`,
      },
    })
  return deduped.length
}

/** Remove all holdings for a fund/month — call before re-inserting so a re-extraction
 *  (which may change the set of securities/categories) leaves no orphan rows behind. */
export async function deleteByFundMonth(sfin: string, month: string, exec: Exec = db): Promise<void> {
  await exec.delete(fundHoldings).where(and(eq(fundHoldings.sfin, sfin), eq(fundHoldings.month, month)))
}

export async function countByFundMonth(sfin: string, month: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(fundHoldings)
    .where(and(eq(fundHoldings.sfin, sfin), eq(fundHoldings.month, month)))
  return rows[0]?.n ?? 0
}

export interface UnmatchedHolding {
  sfin: string
  month: string
  security: string
  weightPct: number | null
}

/** Holdings that did not resolve to an NSE symbol (coverage gaps, surfaced). */
export async function unmatched(month?: string): Promise<UnmatchedHolding[]> {
  const cond = month ? and(isNull(fundHoldings.normalizedSymbol), eq(fundHoldings.month, month)) : isNull(fundHoldings.normalizedSymbol)
  return db
    .select({ sfin: fundHoldings.sfin, month: fundHoldings.month, security: fundHoldings.security, weightPct: fundHoldings.weightPct })
    .from(fundHoldings)
    .where(cond)
    .orderBy(asc(fundHoldings.sfin))
}

export interface HoldingRow {
  security: string
  weightPct: number | null
  normalizedSymbol: string | null
  category: string | null
  rawCategory: string | null
  isin: string | null
  rating: string | null
  marketValue: number | null
}

export async function getForFund(sfin: string, month: string): Promise<HoldingRow[]> {
  return db
    .select({
      security: fundHoldings.security, weightPct: fundHoldings.weightPct, normalizedSymbol: fundHoldings.normalizedSymbol,
      category: fundHoldings.category, rawCategory: fundHoldings.rawCategory, isin: fundHoldings.isin,
      rating: fundHoldings.rating, marketValue: fundHoldings.marketValue,
    })
    .from(fundHoldings)
    .where(and(eq(fundHoldings.sfin, sfin), eq(fundHoldings.month, month)))
    .orderBy(sql`${fundHoldings.weightPct} desc nulls last`)
}
