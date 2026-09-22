// Fund history (time-series) builder for the Insurance Monitor "Trends" tab.
// Assembles a per-month snapshot (NAV, AUM, returns, asset/sector allocation and
// full holdings) across every month a fund is stored, so the UI can analyse what
// changed over a chosen window (2 / 3 / 4 / 6 months).
//
// Only REAL stored months are returned — there is NO synthetic / preview data.
// A fund with a single stored month renders a single-point view; funds with
// multiple months show real window-over-window trends.
import * as fundsRepo from '../repositories/funds'
import * as fundReturnsRepo from '../repositories/fundReturns'
import * as fundHoldingsRepo from '../repositories/fundHoldings'
import * as fundAllocationsRepo from '../repositories/fundAllocations'

export interface HistoryReturn { period: string; returnPct: number | null; benchmarkPct: number | null }
export interface HistoryHolding { security: string; weightPct: number | null; normalizedSymbol: string | null }
export interface HistoryAlloc { label: string; weight: number | null }
export interface HistoryPoint {
  month: string
  nav: number | null
  aumTotalCr: number | null
  aumEquityCr: number | null
  aumDebtCr: number | null
  status: string
  returns: HistoryReturn[]
  assetAlloc: HistoryAlloc[]
  sectorAlloc: HistoryAlloc[]
  holdings: HistoryHolding[] // full, sorted by weight desc
}
export interface FundHistory {
  sfin: string
  name: string | null
  insurer: string | null
  benchmark: string | null
  points: HistoryPoint[] // oldest -> newest
}

async function pointFor(sfin: string, month: string, status: string, snap: Awaited<ReturnType<typeof fundsRepo.getBySfinMonth>>): Promise<HistoryPoint> {
  const [returns, allocations, holdings] = await Promise.all([
    fundReturnsRepo.getForFund(sfin, month),
    fundAllocationsRepo.getForFund(sfin, month),
    fundHoldingsRepo.getForFund(sfin, month),
  ])
  return {
    month,
    nav: snap?.nav ?? null,
    aumTotalCr: snap?.aumTotalCr ?? null,
    aumEquityCr: snap?.aumEquityCr ?? null,
    aumDebtCr: snap?.aumDebtCr ?? null,
    status,
    returns: returns.map((r) => ({ period: r.period, returnPct: r.returnPct, benchmarkPct: r.benchmarkPct })),
    assetAlloc: allocations.filter((a) => a.kind === 'asset').map((a) => ({ label: a.label, weight: a.weight })),
    sectorAlloc: allocations.filter((a) => a.kind === 'sector').map((a) => ({ label: a.label, weight: a.weight })),
    holdings,
  }
}

export async function buildFundHistory(sfin: string): Promise<FundHistory | null> {
  const allMonths = await fundsRepo.distinctMonths() // newest first
  const real: HistoryPoint[] = []
  let meta: { name: string | null; insurer: string | null; benchmark: string | null } | null = null

  for (const month of allMonths) {
    const snap = await fundsRepo.getBySfinMonth(sfin, month)
    if (!snap) continue
    if (!meta) meta = { name: snap.name, insurer: snap.insurer, benchmark: snap.benchmark }
    real.push(await pointFor(sfin, month, snap.status, snap))
  }

  if (real.length === 0) return null
  real.reverse() // oldest -> newest

  // Always serve the real stored series — no synthetic preview (the old always-false `mock`
  // flag was removed as dead shape).
  return { sfin, ...meta!, points: real }
}
