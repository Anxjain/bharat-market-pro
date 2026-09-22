// Mock index quotes and sector performance, shaped like an indices API.
// Phase 2: replace with live NSE/BSE index feed.

import { generateHistory, type PricePoint } from './series'

export interface IndexQuote {
  name: string
  value: number
  changePct: number
  history: PricePoint[]
}

const indexSeeds = [
  { name: 'NIFTY 50', value: 26418.75, changePct: 0.62 },
  { name: 'SENSEX', value: 86934.2, changePct: 0.58 },
  { name: 'NIFTY BANK', value: 57212.4, changePct: 0.94 },
  { name: 'NIFTY FIN SERVICE', value: 26891.1, changePct: 0.71 },
  { name: 'NIFTY IT', value: 39684.3, changePct: -0.88 },
  { name: 'INDIA VIX', value: 13.42, changePct: -3.2 },
]

export const indices: IndexQuote[] = indexSeeds.map((s) => ({
  ...s,
  history: generateHistory(s.name, s.value, 60),
}))

export interface SectorPerf {
  sector: string
  dayChangePct: number
  advancers: number
  decliners: number
}

export const sectorPerformance: SectorPerf[] = [
  { sector: 'Banking', dayChangePct: 0.94, advancers: 9, decliners: 3 },
  { sector: 'Infrastructure', dayChangePct: 1.42, advancers: 11, decliners: 4 },
  { sector: 'Auto', dayChangePct: 1.18, advancers: 8, decliners: 5 },
  { sector: 'Insurance', dayChangePct: 0.36, advancers: 4, decliners: 3 },
  { sector: 'Energy', dayChangePct: 0.58, advancers: 6, decliners: 4 },
  { sector: 'FMCG', dayChangePct: 0.12, advancers: 5, decliners: 6 },
  { sector: 'Pharma', dayChangePct: 0.31, advancers: 7, decliners: 5 },
  { sector: 'IT Services', dayChangePct: -0.92, advancers: 2, decliners: 10 },
  { sector: 'NBFC', dayChangePct: -1.24, advancers: 3, decliners: 8 },
  { sector: 'Metals', dayChangePct: -0.44, advancers: 4, decliners: 7 },
]

export interface MarketBreadth {
  advancers: number
  decliners: number
  unchanged: number
  fiiNetCr: number // FII net flow, ₹ crore (provisional)
  diiNetCr: number
}

export const marketBreadth: MarketBreadth = {
  advancers: 1412,
  decliners: 1186,
  unchanged: 94,
  fiiNetCr: 1840,
  diiNetCr: 2310,
}
