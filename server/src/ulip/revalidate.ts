// Re-run deterministic validation over ALL already-stored funds and update their
// status/confidence/flags. Needed after a validate.ts rule change (e.g. demoting the
// asset-allocation sum check) so previously-quarantined-but-actually-fine funds become
// visible again — without re-fetching/re-extracting any source. Idempotent.
//
// Run: `npm run ulip:revalidate`
import '../load-env'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client'
import { funds } from '../db/schema'
import { validateFund } from './validate'
import type { ExtractedFund } from './types'

/** YYYY-MM one month earlier (string form). */
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mm - 1, 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
import * as fundsRepo from '../repositories/funds'
import * as returnsRepo from '../repositories/fundReturns'
import * as allocRepo from '../repositories/fundAllocations'
import * as holdingsRepo from '../repositories/fundHoldings'

async function main() {
  const all = (await db.select().from(funds)) as fundsRepo.FundRow[]
  console.log(`[revalidate] re-validating ${all.length} stored funds…`)
  let changed = 0, unhidden = 0, nowFailed = 0

  for (const f of all) {
    const [returns, allocs, holds] = await Promise.all([
      returnsRepo.getForFund(f.sfin, f.month),
      allocRepo.getForFund(f.sfin, f.month),
      holdingsRepo.getForFund(f.sfin, f.month),
    ])
    const ef: ExtractedFund = {
      sfin: f.sfin, name: f.name, class: f.class, category: f.category, nav: f.nav,
      inception: f.inception, benchmark: f.benchmark, manager: f.manager, ytm: f.ytm, modifiedDuration: f.modifiedDuration,
      aum: { equity: f.aumEquityCr ?? null, debt: f.aumDebtCr ?? null, mmi: f.aumMmiCr ?? null, total: f.aumTotalCr ?? null },
      returns: returns.map((r) => ({ period: r.period, returnPct: r.returnPct, benchmarkPct: r.benchmarkPct })),
      allocations: allocs.map((a) => ({ kind: a.kind as ExtractedFund['allocations'][number]['kind'], label: a.label, weight: a.weight, fuMin: a.fuMin, fuMax: a.fuMax })),
      holdings: holds.map((h) => ({ security: h.security, weightPct: h.weightPct, category: h.category, rawCategory: h.rawCategory, isin: h.isin, rating: h.rating, marketValue: h.marketValue })),
    }
    const prev = prevMonth(f.month)
    const priorFund = await fundsRepo.getBySfinMonth(f.sfin, prev)
    const priorHoldings = priorFund ? await holdingsRepo.countByFundMonth(f.sfin, prev) : null
    const v = validateFund(ef, { insurerCode: f.insurer, priorNav: priorFund?.nav ?? null, priorHoldingsCount: priorHoldings })

    if (v.status !== f.status) {
      changed++
      if (f.status === 'failed' && v.status !== 'failed') unhidden++
      if (f.status !== 'failed' && v.status === 'failed') nowFailed++
      await db.update(funds).set({ status: v.status, confidence: v.confidence, flags: v.flags }).where(and(eq(funds.sfin, f.sfin), eq(funds.month, f.month)))
    }
  }
  console.log(`[revalidate] done — ${changed} status changes: +${unhidden} un-quarantined (now visible), ${nowFailed} newly quarantined`)
  await pool.end()
}

main().catch((e) => { console.error('[revalidate] failed:', e); process.exit(1) })
