// Mock Indian company master data, shaped like a real fundamentals API response.
// Phase 2: replace this module with an adapter over a licensed market data API.

import { generateHistory, type PricePoint } from './series'

export interface Company {
  symbol: string
  domain: string // company website, used for logo lookup
  name: string
  sector: string
  industry: string
  exchanges: ('NSE' | 'BSE')[]
  price: number // last traded price, INR
  dayChangePct: number
  marketCapCr: number // ₹ crore
  pe: number
  roe: number // %
  debtToEquity: number
  revenueGrowthPct: number // YoY
  profitGrowthPct: number // YoY
  beta: number
  riskScore: number // 0 (safest) – 100 (highest risk), composite
  description: string
  history: PricePoint[]
}

type CompanySeed = Omit<Company, 'history'>

const seeds: CompanySeed[] = [
  {
    symbol: 'RELIANCE', domain: 'ril.com', name: 'Reliance Industries', sector: 'Energy', industry: 'Conglomerate — O2C, Retail, Telecom',
    exchanges: ['NSE', 'BSE'], price: 3284.5, dayChangePct: 0.84, marketCapCr: 2222000, pe: 27.4, roe: 9.8,
    debtToEquity: 0.41, revenueGrowthPct: 8.2, profitGrowthPct: 6.5, beta: 1.05, riskScore: 38,
    description: 'India\'s largest conglomerate spanning oil-to-chemicals, retail (Reliance Retail) and telecom/digital (Jio Platforms).',
  },
  {
    symbol: 'TCS', domain: 'www.tcs.com', name: 'Tata Consultancy Services', sector: 'IT Services', industry: 'IT Consulting & Outsourcing',
    exchanges: ['NSE', 'BSE'], price: 4012.1, dayChangePct: -1.12, marketCapCr: 1452000, pe: 28.9, roe: 50.2,
    debtToEquity: 0.08, revenueGrowthPct: 5.1, profitGrowthPct: 4.3, beta: 0.78, riskScore: 31,
    description: 'Largest Indian IT services exporter; flagship of the Tata group with deep BFSI and retail client base.',
  },
  {
    symbol: 'HDFCBANK', domain: 'hdfcbank.com', name: 'HDFC Bank', sector: 'Banking', industry: 'Private Sector Bank',
    exchanges: ['NSE', 'BSE'], price: 1842.3, dayChangePct: 0.42, marketCapCr: 1404000, pe: 19.6, roe: 16.8,
    debtToEquity: 0, revenueGrowthPct: 14.5, profitGrowthPct: 12.2, beta: 0.92, riskScore: 29,
    description: 'India\'s largest private bank by assets after the HDFC merger; benchmark for retail lending quality.',
  },
  {
    symbol: 'INFY', domain: 'infosys.com', name: 'Infosys', sector: 'IT Services', industry: 'IT Consulting & Outsourcing',
    exchanges: ['NSE', 'BSE'], price: 1689.4, dayChangePct: -0.76, marketCapCr: 700000, pe: 24.1, roe: 31.4,
    debtToEquity: 0.09, revenueGrowthPct: 4.2, profitGrowthPct: 3.8, beta: 0.85, riskScore: 34,
    description: 'Tier-1 IT services major with strong digital transformation and GenAI services practice.',
  },
  {
    symbol: 'ICICIBANK', domain: 'icicibank.com', name: 'ICICI Bank', sector: 'Banking', industry: 'Private Sector Bank',
    exchanges: ['NSE', 'BSE'], price: 1318.7, dayChangePct: 1.21, marketCapCr: 928000, pe: 18.2, roe: 18.4,
    debtToEquity: 0, revenueGrowthPct: 16.1, profitGrowthPct: 15.3, beta: 1.02, riskScore: 33,
    description: 'Second-largest private bank; consistently strong return ratios and digital banking franchise.',
  },
  {
    symbol: 'ITC', domain: 'itcportal.com', name: 'ITC Ltd', sector: 'FMCG', industry: 'Diversified FMCG, Hotels, Paper, Agri',
    exchanges: ['NSE', 'BSE'], price: 512.6, dayChangePct: 0.18, marketCapCr: 640000, pe: 27.8, roe: 28.5,
    debtToEquity: 0.02, revenueGrowthPct: 7.4, profitGrowthPct: 5.9, beta: 0.65, riskScore: 26,
    description: 'Cigarettes-to-FMCG conglomerate with hotels demerged; defensive cash-flow compounder.',
  },
  {
    symbol: 'LT', domain: 'larsentoubro.com', name: 'Larsen & Toubro', sector: 'Infrastructure', industry: 'Engineering & Construction',
    exchanges: ['NSE', 'BSE'], price: 3856.2, dayChangePct: 1.65, marketCapCr: 530000, pe: 32.1, roe: 15.2,
    debtToEquity: 1.12, revenueGrowthPct: 18.9, profitGrowthPct: 21.4, beta: 1.18, riskScore: 45,
    description: 'India\'s largest E&C player; order book leveraged to capex cycle, defence and Middle-East projects.',
  },
  {
    symbol: 'BAJFINANCE', domain: 'bajajfinserv.in', name: 'Bajaj Finance', sector: 'NBFC', industry: 'Consumer & SME Lending',
    exchanges: ['NSE', 'BSE'], price: 7421.8, dayChangePct: -2.05, marketCapCr: 460000, pe: 30.5, roe: 22.1,
    debtToEquity: 3.85, revenueGrowthPct: 26.3, profitGrowthPct: 19.8, beta: 1.25, riskScore: 56,
    description: 'Largest consumer NBFC; high-growth lender with elevated leverage typical of the business model.',
  },
  {
    symbol: 'TATAMOTORS', domain: 'tatamotors.com', name: 'Tata Motors', sector: 'Auto', industry: 'Automobiles — PV, CV, EV (JLR)',
    exchanges: ['NSE', 'BSE'], price: 1042.9, dayChangePct: 2.31, marketCapCr: 383000, pe: 16.4, roe: 24.6,
    debtToEquity: 0.78, revenueGrowthPct: 11.2, profitGrowthPct: 28.7, beta: 1.42, riskScore: 58,
    description: 'PV/CV major and EV leader in India; earnings driven by JLR cycle and domestic CV demand.',
  },
  {
    symbol: 'SUNPHARMA', domain: 'sunpharma.com', name: 'Sun Pharmaceutical', sector: 'Pharma', industry: 'Generics & Specialty Pharma',
    exchanges: ['NSE', 'BSE'], price: 1768.4, dayChangePct: 0.55, marketCapCr: 424000, pe: 34.2, roe: 17.1,
    debtToEquity: 0.06, revenueGrowthPct: 9.8, profitGrowthPct: 12.6, beta: 0.72, riskScore: 36,
    description: 'India\'s largest pharma company; growing specialty portfolio (dermatology, ophthalmics) in the US.',
  },
  // ——— Insurance coverage universe ———
  {
    symbol: 'LICI', domain: 'licindia.in', name: 'Life Insurance Corporation of India', sector: 'Insurance', industry: 'Life Insurance (PSU)',
    exchanges: ['NSE', 'BSE'], price: 1024.3, dayChangePct: 0.31, marketCapCr: 648000, pe: 15.8, roe: 12.4,
    debtToEquity: 0, revenueGrowthPct: 6.1, profitGrowthPct: 8.9, beta: 0.88, riskScore: 41,
    description: 'India\'s largest life insurer with dominant agency channel; market share gradually ceding to private players.',
  },
  {
    symbol: 'SBILIFE', domain: 'sbilife.co.in', name: 'SBI Life Insurance', sector: 'Insurance', industry: 'Life Insurance (Private)',
    exchanges: ['NSE', 'BSE'], price: 1689.2, dayChangePct: 0.92, marketCapCr: 169000, pe: 72.4, roe: 14.1,
    debtToEquity: 0, revenueGrowthPct: 14.8, profitGrowthPct: 11.2, beta: 0.95, riskScore: 35,
    description: 'Largest private life insurer by new business; unmatched bancassurance reach via SBI branches.',
  },
  {
    symbol: 'HDFCLIFE', domain: 'hdfclife.com', name: 'HDFC Life Insurance', sector: 'Insurance', industry: 'Life Insurance (Private)',
    exchanges: ['NSE', 'BSE'], price: 712.8, dayChangePct: -0.48, marketCapCr: 153000, pe: 84.1, roe: 11.8,
    debtToEquity: 0.04, revenueGrowthPct: 13.2, profitGrowthPct: 10.4, beta: 0.91, riskScore: 37,
    description: 'Top-3 private life insurer known for balanced product mix and consistent VNB margin delivery.',
  },
  {
    symbol: 'ICICIGI', domain: 'icicilombard.com', name: 'ICICI Lombard General Insurance', sector: 'Insurance', industry: 'General Insurance',
    exchanges: ['NSE', 'BSE'], price: 2104.6, dayChangePct: 1.08, marketCapCr: 104000, pe: 42.3, roe: 17.9,
    debtToEquity: 0.03, revenueGrowthPct: 17.4, profitGrowthPct: 21.8, beta: 0.83, riskScore: 39,
    description: 'Largest private general insurer; motor and health led, strong digital distribution.',
  },
  {
    symbol: 'STARHEALTH', domain: 'starhealth.in', name: 'Star Health & Allied Insurance', sector: 'Insurance', industry: 'Health Insurance',
    exchanges: ['NSE', 'BSE'], price: 612.4, dayChangePct: -1.84, marketCapCr: 36000, pe: 38.6, roe: 13.2,
    debtToEquity: 0.05, revenueGrowthPct: 15.6, profitGrowthPct: 9.1, beta: 1.08, riskScore: 52,
    description: 'Largest standalone health insurer; retail health leader facing claims-ratio and repricing pressure.',
  },
]

export const companies: Company[] = seeds.map((s) => ({
  ...s,
  history: generateHistory(s.symbol, s.price),
}))

export const companyBySymbol = new Map(companies.map((c) => [c.symbol, c]))

export const insurers = companies.filter((c) => c.sector === 'Insurance')

// Insurance-specific KPIs (would come from insurer disclosures / IRDAI data in Phase 2).
export interface InsuranceMetrics {
  symbol: string
  type: 'Life' | 'General' | 'Health'
  vnbMarginPct?: number // life only
  solvencyRatio: number // regulatory minimum 1.5
  persistency13mPct?: number // life only
  combinedRatioPct?: number // general/health only
  apeGrowthPct?: number
  embeddedValueCr?: number
  marketSharePct: number
}

export const insuranceMetrics: InsuranceMetrics[] = [
  { symbol: 'LICI', type: 'Life', vnbMarginPct: 17.2, solvencyRatio: 1.98, persistency13mPct: 78.4, apeGrowthPct: 4.8, embeddedValueCr: 760000, marketSharePct: 57.4 },
  { symbol: 'SBILIFE', type: 'Life', vnbMarginPct: 28.4, solvencyRatio: 2.04, persistency13mPct: 86.7, apeGrowthPct: 13.9, embeddedValueCr: 61000, marketSharePct: 12.1 },
  { symbol: 'HDFCLIFE', type: 'Life', vnbMarginPct: 26.1, solvencyRatio: 1.92, persistency13mPct: 87.9, apeGrowthPct: 12.2, embeddedValueCr: 52000, marketSharePct: 10.8 },
  { symbol: 'ICICIGI', type: 'General', solvencyRatio: 2.62, combinedRatioPct: 103.1, apeGrowthPct: 17.4, marketSharePct: 8.6 },
  { symbol: 'STARHEALTH', type: 'Health', solvencyRatio: 2.21, combinedRatioPct: 98.7, apeGrowthPct: 15.6, marketSharePct: 31.2 },
]
