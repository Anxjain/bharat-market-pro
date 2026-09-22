// Seed the REAL listed-insurer KPI table (replaces the old illustrative sample set).
// Figures are FY2026 (12 months ended 31 Mar 2026) full-year results, sourced from
// each insurer's official IR release / investor presentation (+ IRDAI/council data).
// Run: `npm run seed:insurer-kpis` (idempotent upsert).
//
// Sourcing notes (kept honest):
//  • Star Health solvency is left NULL — it was not in the official FY26 press release
//    and only appeared in a secondary aggregator, so we do not assert it.
//  • marketSharePct denominators differ by what each insurer reports: LIC = total
//    industry; SBI Life = private new-business; HDFC = overall NB; ICICI Lombard =
//    overall non-life; Star Health = retail-health (SAHI). Source link carries context.
import '../load-env'
import * as repo from '../repositories/insurerKpis'
import { pool } from '../db/client'
import type { InsurerKpiRow } from '../repositories/insurerKpis'

const now = new Date().toISOString()
const PERIOD = 'FY26'

const ROWS: InsurerKpiRow[] = [
  {
    symbol: 'LICI', type: 'Life',
    vnbMarginPct: 21.2, solvencyRatio: 2.35, persistency13mPct: 74.64,
    combinedRatioPct: null, apeGrowthPct: 17.83, embeddedValueCr: 789185, marketSharePct: 56.66,
    period: PERIOD, sourceUrl: 'https://licindia.in/web/guest/press-release', updatedAt: now,
  },
  {
    symbol: 'SBILIFE', type: 'Life',
    vnbMarginPct: 27.5, solvencyRatio: 1.90, persistency13mPct: 87.9,
    combinedRatioPct: null, apeGrowthPct: 13.4, embeddedValueCr: 80790, marketSharePct: 25.5,
    period: PERIOD, sourceUrl: 'https://www.sbilife.co.in/en/about-us/investor-relations', updatedAt: now,
  },
  {
    symbol: 'HDFCLIFE', type: 'Life',
    vnbMarginPct: 24.5, solvencyRatio: 1.77, persistency13mPct: 86,
    combinedRatioPct: null, apeGrowthPct: 7, embeddedValueCr: 62139, marketSharePct: 10.8,
    period: PERIOD, sourceUrl: 'https://www.hdfclife.com/about-us/investor-relations', updatedAt: now,
  },
  {
    symbol: 'ICICIGI', type: 'General',
    vnbMarginPct: null, solvencyRatio: 2.67, persistency13mPct: null,
    combinedRatioPct: 103.4, apeGrowthPct: 7.0, embeddedValueCr: null, marketSharePct: 8.5,
    period: PERIOD, sourceUrl: 'https://www.icicilombard.com/investor-relations', updatedAt: now,
  },
  {
    symbol: 'STARHEALTH', type: 'Health',
    vnbMarginPct: null, solvencyRatio: null, persistency13mPct: null,
    combinedRatioPct: 98.8, apeGrowthPct: 16, embeddedValueCr: null, marketSharePct: 31,
    period: PERIOD, sourceUrl: 'https://www.starhealth.in/investor-relations', updatedAt: now,
  },
]

async function main() {
  const n = await repo.upsertMany(ROWS)
  console.log(`[seed] insurer_kpis: upserted ${n} rows (period ${PERIOD})`)
  await pool.end()
}

main().catch((e) => { console.error('[seed] failed:', e); process.exit(1) })
