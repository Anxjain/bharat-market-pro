// Store extracted funds into Postgres, keyed by (SFIN, month). Each fund is
// validated deterministically (validate.ts) -> confidence + flags + bucket, AUM
// is normalized to a canonical unit (crore) while the as-printed value is kept,
// and holdings are resolved to NSE symbols via the alias map. Failed funds are
// still written but tagged 'failed' (quarantined: the visible read path hides
// them; the review queue surfaces them).
import { normalizeSfin, normSecurity, type ExtractedFund } from './types'
import { validateFund } from './validate'
import { canonPeriod } from './chat'
import { db } from '../db/client'
import type { UlipAdapter } from './adapters'
import * as fundsRepo from '../repositories/funds'
import * as fundReturnsRepo from '../repositories/fundReturns'
import * as fundAllocationsRepo from '../repositories/fundAllocations'
import * as fundHoldingsRepo from '../repositories/fundHoldings'
import * as aliasesRepo from '../repositories/securityAliases'

export interface StoreResult {
  stored: number
  byStatus: { clean: number; suspicious: number; failed: number }
  failedSfins: string[]
}

/** YYYY-MM one month earlier. */
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mm - 1, 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** AUM unit -> INR Crore multiplier. */
function toCrore(unit: 'lakh' | 'crore'): number {
  return unit === 'lakh' ? 0.01 : 1
}

/** Derive a per-field coverage ledger from what was extracted (parser may override via f.coverage). */
function deriveCoverage(f: ExtractedFund): Record<string, string> {
  const has = (b: boolean) => (b ? 'present' : 'absent')
  return {
    nav: has(f.nav != null),
    aum: has(f.aum?.total != null),
    returns: has(f.returns.length > 0),
    asset: has(f.allocations.some((a) => a.kind === 'asset')),
    sector: has(f.allocations.some((a) => a.kind === 'sector')),
    holdings: has(f.holdings.length > 0),
    isin: has(f.holdings.some((h) => h.isin)),
    ...(f.coverage ?? {}),
  }
}

export async function store(adapter: UlipAdapter, month: string, funds: ExtractedFund[]): Promise<StoreResult> {
  const aliasMap = new Map((await aliasesRepo.all()).map((a) => [a.alias, a.symbol]))
  const resolve = (name: string): string | null => aliasMap.get(normSecurity(name)) ?? null
  const factor = toCrore(adapter.aumUnit)
  const cr = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * factor * 1e4) / 1e4)

  const prev = prevMonth(month)
  const result: StoreResult = { stored: 0, byStatus: { clean: 0, suspicious: 0, failed: 0 }, failedSfins: [] }

  for (const f of funds) {
    const sfin = normalizeSfin(f.sfin)

    // Prior-month context for MoM / holding-count drift checks.
    const priorFund = await fundsRepo.getBySfinMonth(sfin, prev)
    const priorHoldings = priorFund ? await fundHoldingsRepo.countByFundMonth(sfin, prev) : null

    const v = validateFund(f, {
      insurerCode: adapter.irdaiCode,
      priorNav: priorFund?.nav ?? null,
      priorHoldingsCount: priorHoldings,
    })

    // Atomic per-fund write: header upsert + clean-replace of the three child tables must
    // succeed or fail together. A crash/OOM mid-sequence otherwise leaves a fund whose header
    // says status='clean' with zero holdings/returns/allocations (served as valid, never repaired).
    await db.transaction(async (tx) => {
      await fundsRepo.upsert({
        sfin,
        month,
        insurer: adapter.irdaiCode,
        name: f.name,
        class: f.class ?? null,
        category: f.category ?? null,
        nav: f.nav ?? null,
        inception: f.inception ?? null,
        benchmark: f.benchmark ?? null,
        manager: f.manager ?? null,
        ytm: f.ytm ?? null,
        modifiedDuration: f.modifiedDuration ?? null,
        managedSummary: f.managedSummary ?? null,
        aumEquity: f.aum?.equity ?? null,
        aumDebt: f.aum?.debt ?? null,
        aumMmi: f.aum?.mmi ?? null,
        aumTotal: f.aum?.total ?? null,
        aumUnit: adapter.aumUnit,
        aumEquityCr: cr(f.aum?.equity),
        aumDebtCr: cr(f.aum?.debt),
        aumMmiCr: cr(f.aum?.mmi),
        aumTotalCr: cr(f.aum?.total),
        status: v.status,
        confidence: v.confidence,
        flags: v.flags,
        coverage: deriveCoverage(f),
      }, tx)

      // Clean-replace children: a re-extraction can change the SET of returns/allocations/
      // holdings (different categories, fewer securities) — upsert alone would leave orphans.
      await fundReturnsRepo.deleteByFundMonth(sfin, month, tx)
      await fundAllocationsRepo.deleteByFundMonth(sfin, month, tx)
      await fundHoldingsRepo.deleteByFundMonth(sfin, month, tx)

      await fundReturnsRepo.upsertMany(
        // Canonicalize the period label once here (e.g. "1 Year" -> "1Y") so downstream
        // readers (excel 1Y/3Y/Inception columns) find Gemini-extracted returns by key.
        f.returns.map((r) => ({ sfin, month, period: canonPeriod(r.period), returnPct: r.returnPct, benchmarkPct: r.benchmarkPct })),
        tx,
      )
      await fundAllocationsRepo.upsertMany(
        f.allocations.map((a) => ({ sfin, month, kind: a.kind, label: a.label, weight: a.weight ?? null, fuMin: a.fuMin ?? null, fuMax: a.fuMax ?? null })),
        tx,
      )
      await fundHoldingsRepo.upsertMany(
        f.holdings.map((h) => ({
          sfin, month, security: h.security, weightPct: h.weightPct ?? null, normalizedSymbol: resolve(h.security),
          // NO normalization: store + display the factsheet's verbatim section label as-is.
          // `category` and `rawCategory` are both the raw label (kept distinct for schema stability).
          rawCategory: h.rawCategory ?? h.category ?? null,
          category: h.rawCategory ?? h.category ?? null,
          isin: h.isin ?? null, rating: h.rating ?? null, marketValue: h.marketValue ?? null,
        })),
        tx,
      )
    })

    result.stored++
    result.byStatus[v.status]++
    if (v.status === 'failed') result.failedSfins.push(sfin)
  }

  return result
}
