// Repository: funds (one headline sheet per SFIN per month) + validation state.
import { and, eq, ne, lte, asc, desc, isNotNull, sql } from 'drizzle-orm'
import { db, type DB } from '../db/client'
import { funds } from '../db/schema'

// Executor = the shared db OR a transaction handle, so a caller can thread a `tx`.
type Exec = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

export interface FundFlag {
  code: string
  severity: string
  message: string
}

export interface FundRow {
  sfin: string
  month: string
  insurer: string
  name: string
  class: string | null
  category: string | null
  nav: number | null
  inception: string | null
  benchmark: string | null
  manager: string | null
  ytm: number | null
  modifiedDuration: number | null
  managedSummary: string | null
  aumEquity: number | null
  aumDebt: number | null
  aumMmi: number | null
  aumTotal: number | null
  aumUnit: string | null
  aumEquityCr: number | null
  aumDebtCr: number | null
  aumMmiCr: number | null
  aumTotalCr: number | null
  status: string
  confidence: number | null
  flags: FundFlag[]
  coverage?: Record<string, string>
  sourceKind?: string | null
  sourcePage?: number | null
}

export async function upsert(row: FundRow, exec: Exec = db): Promise<void> {
  await exec
    .insert(funds)
    .values(row)
    .onConflictDoUpdate({
      target: [funds.sfin, funds.month],
      set: {
        insurer: sql`excluded.insurer`,
        name: sql`excluded.name`,
        class: sql`excluded.class`,
        category: sql`excluded.category`,
        nav: sql`excluded.nav`,
        inception: sql`excluded.inception`,
        benchmark: sql`excluded.benchmark`,
        manager: sql`excluded.manager`,
        ytm: sql`excluded.ytm`,
        modifiedDuration: sql`excluded.modified_duration`,
        managedSummary: sql`excluded.managed_summary`,
        aumEquity: sql`excluded.aum_equity`,
        aumDebt: sql`excluded.aum_debt`,
        aumMmi: sql`excluded.aum_mmi`,
        aumTotal: sql`excluded.aum_total`,
        aumUnit: sql`excluded.aum_unit`,
        aumEquityCr: sql`excluded.aum_equity_cr`,
        aumDebtCr: sql`excluded.aum_debt_cr`,
        aumMmiCr: sql`excluded.aum_mmi_cr`,
        aumTotalCr: sql`excluded.aum_total_cr`,
        status: sql`excluded.status`,
        confidence: sql`excluded.confidence`,
        flags: sql`excluded.flags`,
        coverage: sql`excluded.coverage`,
      },
    })
}

export async function getBySfinMonth(sfin: string, month: string): Promise<FundRow | null> {
  const rows = await db.select().from(funds).where(and(eq(funds.sfin, sfin), eq(funds.month, month))).limit(1)
  return (rows[0] as FundRow) ?? null
}

export async function countByInsurerMonth(insurer: string, month: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(funds)
    .where(and(eq(funds.insurer, insurer), eq(funds.month, month)))
  return rows[0]?.n ?? 0
}

/** All funds for an insurer/month (includes quarantined). */
export async function listByInsurerMonth(insurer: string, month: string): Promise<FundRow[]> {
  return db.select().from(funds).where(and(eq(funds.insurer, insurer), eq(funds.month, month))).orderBy(asc(funds.sfin)) as Promise<FundRow[]>
}

/** Shown to users: clean + suspicious (suspicious carries an "unverified" marker). */
export async function listVisible(insurer: string, month: string): Promise<FundRow[]> {
  return db
    .select()
    .from(funds)
    .where(and(eq(funds.insurer, insurer), eq(funds.month, month), ne(funds.status, 'failed')))
    .orderBy(asc(funds.sfin)) as Promise<FundRow[]>
}

/** Quarantine / review queue: failed funds (never shown to users). */
export async function listQuarantined(month?: string): Promise<FundRow[]> {
  const cond = month ? and(eq(funds.status, 'failed'), eq(funds.month, month)) : eq(funds.status, 'failed')
  return db.select().from(funds).where(cond).orderBy(asc(funds.sfin)) as Promise<FundRow[]>
}

export async function distinctMonths(): Promise<string[]> {
  const rows = await db.selectDistinct({ month: funds.month }).from(funds).orderBy(desc(funds.month))
  return rows.map((r) => r.month)
}

export async function latestMonth(): Promise<string | null> {
  const rows = await db.selectDistinct({ month: funds.month }).from(funds).orderBy(desc(funds.month)).limit(1)
  return rows[0]?.month ?? null
}

/** Latest month WITH visible funds for one insurer, optionally capped at `upto`
 *  (≤ the globally-selected month). Lets an insurer whose data lags the picked month
 *  still surface its newest available data instead of an empty list. */
export async function latestMonthForInsurer(insurer: string, upto?: string): Promise<string | null> {
  const conds = [eq(funds.insurer, insurer), ne(funds.status, 'failed')]
  if (upto) conds.push(lte(funds.month, upto))
  const rows = await db
    .selectDistinct({ month: funds.month })
    .from(funds)
    .where(and(...conds))
    .orderBy(desc(funds.month))
    .limit(1)
  return rows[0]?.month ?? null
}

/** "Best available per insurer" for a browse view: every visible fund at each insurer's
 *  latest month ≤ `upto`. Each row keeps its own `month`, so an insurer that only has
 *  May data still shows it when July is the globally-selected month. */
export async function listVisibleBestPerInsurer(upto: string): Promise<FundRow[]> {
  const all = (await db
    .select()
    .from(funds)
    .where(and(ne(funds.status, 'failed'), lte(funds.month, upto)))
    .orderBy(asc(funds.insurer), asc(funds.sfin))) as FundRow[]
  const latestByInsurer = new Map<string, string>()
  for (const r of all) {
    const cur = latestByInsurer.get(r.insurer)
    if (!cur || r.month > cur) latestByInsurer.set(r.insurer, r.month)
  }
  return all.filter((r) => r.month === latestByInsurer.get(r.insurer))
}

/**
 * The "primary" month for the picker default: the LATEST month with broad insurer
 * coverage (≥ half the busiest month's distinct-insurer count). Prevents the picker from
 * opening on a sparse leading-edge month — e.g. when only 1 insurer (Shriram) has posted
 * June, every other insurer would fall back to May under a "June" label. Self-adjusting:
 * once June fills out, it becomes the default automatically.
 */
export async function primaryMonth(): Promise<string | null> {
  const rows = await db
    .select({ month: funds.month, insurers: sql<number>`cast(count(distinct ${funds.insurer}) as int)` })
    .from(funds)
    .where(ne(funds.status, 'failed'))
    .groupBy(funds.month)
  if (rows.length === 0) return null
  const maxIns = Math.max(...rows.map((r) => r.insurers))
  const threshold = Math.max(1, Math.ceil(maxIns * 0.5))
  const eligible = rows.filter((r) => r.insurers >= threshold).map((r) => r.month).sort().reverse()
  const allDesc = rows.map((r) => r.month).sort().reverse()
  return eligible[0] ?? allDesc[0] ?? null
}

/** Distinct (non-failed) fund categories for a month — drives the type dropdown. */
export async function distinctCategories(month: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: funds.category })
    .from(funds)
    .where(and(eq(funds.month, month), ne(funds.status, 'failed'), isNotNull(funds.category)))
    .orderBy(asc(funds.category))
  return rows.map((r) => r.category).filter((c): c is string => Boolean(c))
}

/** All visible (clean+suspicious) funds for a month, across insurers. */
export async function listVisibleAllMonth(month: string): Promise<FundRow[]> {
  return db
    .select()
    .from(funds)
    .where(and(eq(funds.month, month), ne(funds.status, 'failed')))
    .orderBy(asc(funds.insurer), asc(funds.sfin)) as Promise<FundRow[]>
}

/** Visible funds of a category for a month, across insurers (section view/export). */
export async function byCategory(month: string, category: string): Promise<FundRow[]> {
  return db
    .select()
    .from(funds)
    .where(and(eq(funds.month, month), eq(funds.category, category), ne(funds.status, 'failed')))
    .orderBy(asc(funds.insurer), asc(funds.sfin)) as Promise<FundRow[]>
}
