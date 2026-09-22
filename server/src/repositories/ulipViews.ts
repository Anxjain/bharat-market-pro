// Cross-table ULIP read views (joins live here, in the repository layer, so routes
// stay SQL-free): consolidated cross-insurer holdings joined to the NSE master.
import { and, eq, ne, desc, asc, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { fundHoldings, funds, instruments, insurers } from '../db/schema'

export interface HolderRow {
  insurer: string
  insurerName: string | null
  sfin: string
  fundName: string
  fundStatus: string
  security: string
  weightPct: number | null
}

/** Which insurers/funds hold a given NSE symbol, and at what weight (flagship view). */
export async function consolidatedHolders(symbol: string, month: string): Promise<HolderRow[]> {
  return db
    .select({
      insurer: funds.insurer,
      insurerName: insurers.name,
      sfin: funds.sfin,
      fundName: funds.name,
      fundStatus: funds.status,
      security: fundHoldings.security,
      weightPct: fundHoldings.weightPct,
    })
    .from(fundHoldings)
    .innerJoin(funds, and(eq(funds.sfin, fundHoldings.sfin), eq(funds.month, fundHoldings.month)))
    .leftJoin(insurers, eq(insurers.irdaiCode, funds.insurer))
    .where(and(eq(fundHoldings.normalizedSymbol, symbol), eq(fundHoldings.month, month), ne(funds.status, 'failed')))
    .orderBy(desc(fundHoldings.weightPct))
}

export interface SymbolOption {
  symbol: string
  company: string | null
  holders: number
}

/** Distinct NSE symbols held across visible funds in a month (the picker list). */
export async function heldSymbols(month: string): Promise<SymbolOption[]> {
  const rows = await db
    .select({
      symbol: fundHoldings.normalizedSymbol,
      company: instruments.name,
      holders: sql<number>`cast(count(*) as int)`,
    })
    .from(fundHoldings)
    .innerJoin(funds, and(eq(funds.sfin, fundHoldings.sfin), eq(funds.month, fundHoldings.month)))
    .leftJoin(instruments, eq(instruments.symbol, fundHoldings.normalizedSymbol))
    .where(and(eq(fundHoldings.month, month), ne(funds.status, 'failed'), isNotNull(fundHoldings.normalizedSymbol)))
    .groupBy(fundHoldings.normalizedSymbol, instruments.name)
    .orderBy(desc(sql`count(*)`), asc(fundHoldings.normalizedSymbol))
  return rows.map((r) => ({ symbol: r.symbol as string, company: r.company, holders: r.holders }))
}

export interface RolledHolding {
  symbol: string | null
  company: string | null
  security: string
  insurer: string
  insurerName: string | null
  sfin: string
  fundName: string
  weightPct: number | null
}

/** Every mapped holding across visible funds for a month — feeds the consolidated export. */
export async function rolledHoldings(month: string): Promise<RolledHolding[]> {
  return db
    .select({
      symbol: fundHoldings.normalizedSymbol,
      company: instruments.name,
      security: fundHoldings.security,
      insurer: funds.insurer,
      insurerName: insurers.name,
      sfin: funds.sfin,
      fundName: funds.name,
      weightPct: fundHoldings.weightPct,
    })
    .from(fundHoldings)
    .innerJoin(funds, and(eq(funds.sfin, fundHoldings.sfin), eq(funds.month, fundHoldings.month)))
    .leftJoin(insurers, eq(insurers.irdaiCode, funds.insurer))
    .leftJoin(instruments, eq(instruments.symbol, fundHoldings.normalizedSymbol))
    .where(and(eq(fundHoldings.month, month), ne(funds.status, 'failed')))
    .orderBy(asc(fundHoldings.normalizedSymbol), desc(fundHoldings.weightPct))
}

// ——— Month-over-month: what a fund added / trimmed / bought / sold vs prior month ———
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mm - 1, 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface MoMChange { security: string; prev: number | null; now: number | null; delta: number }
export interface FundMoM {
  sfin: string
  month: string
  prevMonth: string
  hasPrev: boolean
  added: MoMChange[]
  removed: MoMChange[]
  increased: MoMChange[]
  decreased: MoMChange[]
  unchanged: number
}

export async function fundMoM(sfin: string, month: string): Promise<FundMoM> {
  const prev = prevMonth(month)
  const grab = (m: string) =>
    db.select({ security: fundHoldings.security, weightPct: fundHoldings.weightPct }).from(fundHoldings).where(and(eq(fundHoldings.sfin, sfin), eq(fundHoldings.month, m)))
  const [nowRows, prevRows] = await Promise.all([grab(month), grab(prev)])
  const nowMap = new Map(nowRows.map((r) => [r.security, r.weightPct]))
  const prevMap = new Map(prevRows.map((r) => [r.security, r.weightPct]))

  const added: MoMChange[] = []
  const removed: MoMChange[] = []
  const increased: MoMChange[] = []
  const decreased: MoMChange[] = []
  let unchanged = 0
  const EPS = 0.01

  for (const [sec, now] of nowMap) {
    if (!prevMap.has(sec)) { added.push({ security: sec, prev: null, now, delta: now ?? 0 }); continue }
    const prevW = prevMap.get(sec) ?? 0
    const delta = (now ?? 0) - (prevW ?? 0)
    if (delta > EPS) increased.push({ security: sec, prev: prevW, now, delta })
    else if (delta < -EPS) decreased.push({ security: sec, prev: prevW, now, delta })
    else unchanged++
  }
  for (const [sec, prevW] of prevMap) {
    if (!nowMap.has(sec)) removed.push({ security: sec, prev: prevW, now: null, delta: -(prevW ?? 0) })
  }
  const byAbs = (a: MoMChange, b: MoMChange) => Math.abs(b.delta) - Math.abs(a.delta)
  added.sort(byAbs); removed.sort(byAbs); increased.sort(byAbs); decreased.sort(byAbs)
  return { sfin, month, prevMonth: prev, hasPrev: prevRows.length > 0, added, removed, increased, decreased, unchanged }
}
