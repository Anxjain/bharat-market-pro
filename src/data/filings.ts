// Mock NSE/BSE corporate filings, shaped like exchange announcement feeds.
// Phase 2: replace with official NSE/BSE announcement APIs or a filings vendor.

export type FilingCategory =
  | 'Financial Results'
  | 'Board Meeting'
  | 'Insider Trading / SAST'
  | 'Credit Rating'
  | 'Order Win / Contract'
  | 'Regulatory'
  | 'Corporate Action'
  | 'Investor Presentation'

export type Materiality = 'high' | 'medium' | 'low'

export interface Filing {
  id: string
  exchange: 'NSE' | 'BSE'
  symbol: string
  category: FilingCategory
  title: string
  filedAt: string // ISO
  materiality: Materiality
  aiSummary: string // one-line digest (rule-generated for prototype)
}

export const filings: Filing[] = [
  {
    id: 'f1', exchange: 'NSE', symbol: 'RELIANCE', category: 'Corporate Action',
    title: 'Intimation: Draft Red Herring Prospectus filed by Reliance Retail Ventures Ltd',
    filedAt: '2026-06-11T08:55:00+05:30', materiality: 'high',
    aiSummary: 'Retail arm IPO formally initiated — a major value-unlocking event; listing expected H2 FY27 subject to SEBI approval.',
  },
  {
    id: 'f2', exchange: 'BSE', symbol: 'LT', category: 'Order Win / Contract',
    title: 'Award of significant order — Hydrocarbon Onshore vertical (international)',
    filedAt: '2026-06-08T09:45:00+05:30', materiality: 'high',
    aiSummary: '₹12,000 cr Middle East EPC win; "significant" band confirms one of the largest single orders this fiscal.',
  },
  {
    id: 'f3', exchange: 'NSE', symbol: 'BAJFINANCE', category: 'Credit Rating',
    title: 'CRISIL reaffirms AAA/Stable; revises outlook commentary on unsecured book seasoning',
    filedAt: '2026-06-09T17:30:00+05:30', materiality: 'medium',
    aiSummary: 'Rating unchanged but commentary explicitly flags unsecured personal-loan seasoning — aligns with RBI FSR caution.',
  },
  {
    id: 'f4', exchange: 'NSE', symbol: 'SBILIFE', category: 'Financial Results',
    title: 'Disclosure of monthly new business premium for May 2026 (IRDAI format)',
    filedAt: '2026-06-09T15:10:00+05:30', materiality: 'medium',
    aiSummary: 'APE +14% YoY, ahead of private-industry +11%; protection share ticked up 80bps sequentially.',
  },
  {
    id: 'f5', exchange: 'BSE', symbol: 'HDFCLIFE', category: 'Regulatory',
    title: 'Response to IRDAI draft circular on Expenses of Management — industry consultation',
    filedAt: '2026-06-10T16:40:00+05:30', materiality: 'medium',
    aiSummary: 'Company will submit consolidated industry feedback via Life Insurance Council; flags FY28 transition timeline as key ask.',
  },
  {
    id: 'f6', exchange: 'NSE', symbol: 'TCS', category: 'Board Meeting',
    title: 'Board meeting intimation — Q1 FY27 results and interim dividend consideration',
    filedAt: '2026-06-10T18:00:00+05:30', materiality: 'low',
    aiSummary: 'Routine: results on July 9; an interim dividend item is on the agenda as in prior years.',
  },
  {
    id: 'f7', exchange: 'NSE', symbol: 'TATAMOTORS', category: 'Insider Trading / SAST',
    title: 'Disclosure under SEBI (PIT) Regulations — designated person acquisition',
    filedAt: '2026-06-07T13:25:00+05:30', materiality: 'low',
    aiSummary: 'Small ESOP-linked acquisition by a designated person; no signal value beyond routine compliance.',
  },
  {
    id: 'f8', exchange: 'BSE', symbol: 'STARHEALTH', category: 'Regulatory',
    title: 'Product filing: revised group health premium rates effective August 2026',
    filedAt: '2026-06-07T16:55:00+05:30', materiality: 'high',
    aiSummary: '12% group health repricing filed — margin-restorative but raises renewal/retention risk in price-sensitive accounts.',
  },
  {
    id: 'f9', exchange: 'NSE', symbol: 'ICICIGI', category: 'Investor Presentation',
    title: 'Investor presentation — May 2026 business update',
    filedAt: '2026-06-06T18:20:00+05:30', materiality: 'low',
    aiSummary: 'Motor combined ratio at 101.8% (improving); health retail +24% YoY; no change to medium-term CoR guidance.',
  },
  {
    id: 'f10', exchange: 'NSE', symbol: 'INFY', category: 'Order Win / Contract',
    title: 'Press release: strategic collaboration agreement with European banking group',
    filedAt: '2026-06-05T08:50:00+05:30', materiality: 'high',
    aiSummary: '$2bn TCV over 7 years — largest ever; AI-platform-led, revenue conversion expected from Q3 FY27.',
  },
  {
    id: 'f11', exchange: 'BSE', symbol: 'ITC', category: 'Corporate Action',
    title: 'Record date intimation for ITC Hotels demerger entitlement',
    filedAt: '2026-06-06T09:30:00+05:30', materiality: 'medium',
    aiSummary: 'Record date June 26; shareholders receive 1 ITC Hotels share per 10 ITC shares held.',
  },
  {
    id: 'f12', exchange: 'NSE', symbol: 'HDFCBANK', category: 'Financial Results',
    title: 'Analyst day transcript and balance-sheet normalisation update',
    filedAt: '2026-06-05T19:15:00+05:30', materiality: 'medium',
    aiSummary: 'LDR at 98%, CASA 38%; management reiterates NIM band and mid-teens loan growth from FY27.',
  },
  {
    id: 'f13', exchange: 'NSE', symbol: 'LICI', category: 'Financial Results',
    title: 'Embedded value disclosure and analyst presentation FY26',
    filedAt: '2026-06-04T17:45:00+05:30', materiality: 'high',
    aiSummary: 'EV +6% YoY to ₹7.6 lakh cr; persistency assumption changes drew analyst scrutiny — watch follow-up disclosures.',
  },
  {
    id: 'f14', exchange: 'BSE', symbol: 'SUNPHARMA', category: 'Investor Presentation',
    title: 'Specialty business update — Ilumya/Winlevi US performance',
    filedAt: '2026-06-06T14:05:00+05:30', materiality: 'medium',
    aiSummary: 'Specialty annualised run-rate $1.4bn; FY27 specialty growth guidance raised to mid-teens.',
  },
]
