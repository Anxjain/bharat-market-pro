// Mock risk events feeding the Risk Monitor.
// Phase 2: derive from real signals (filings NLP, news velocity, ratings, price anomalies).

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low'

export type RiskType =
  | 'Regulatory'
  | 'Credit / Leverage'
  | 'Earnings Quality'
  | 'Market / Volatility'
  | 'Governance'
  | 'Competitive'
  | 'Concentration'

export interface RiskEvent {
  id: string
  symbol: string
  type: RiskType
  severity: RiskSeverity
  title: string
  description: string
  detectedAt: string // ISO
  signalSource: string // what triggered this flag
}

export const riskEvents: RiskEvent[] = [
  {
    id: 'r1', symbol: 'BAJFINANCE', type: 'Credit / Leverage', severity: 'high',
    title: 'Unsecured lending stress flagged by RBI Financial Stability Report',
    description: 'RBI FSR highlights rising delinquencies in sub-₹50k personal loans across the system. Bajaj Finance has the largest unsecured consumer book among NBFCs; rating agency commentary now also references book seasoning. Watch Q1 FY27 Stage-2/Stage-3 disclosures.',
    detectedAt: '2026-06-09T12:30:00+05:30', signalSource: 'RBI FSR + CRISIL rating commentary',
  },
  {
    id: 'r2', symbol: 'STARHEALTH', type: 'Competitive', severity: 'high',
    title: 'Repricing-driven retention risk in group health',
    description: '12% premium hike filed to restore loss ratios. Group health is price-sensitive; aggressive PSU and new standalone health insurers may pick up churned accounts. Renewal-rate disclosure in Q2 will confirm or clear this flag.',
    detectedAt: '2026-06-07T17:20:00+05:30', signalSource: 'BSE product filing + news velocity',
  },
  {
    id: 'r3', symbol: 'LICI', type: 'Earnings Quality', severity: 'medium',
    title: 'Embedded value assumption changes under analyst scrutiny',
    description: 'FY26 EV growth of 6% partly reflects loosened persistency assumptions. If assumptions revert, EV growth could be restated lower. Market-share drift to private insurers continues in parallel.',
    detectedAt: '2026-06-04T17:45:00+05:30', signalSource: 'EV disclosure NLP + analyst notes',
  },
  {
    id: 'r4', symbol: 'TCS', type: 'Earnings Quality', severity: 'medium',
    title: 'BFSI discretionary spend pushouts pressure near-term revenue conversion',
    description: 'Management flagged delayed decision-making in North America BFSI. Deal TCV is steady, so this is a timing risk rather than demand destruction — but Q1/Q2 revenue growth may undershoot consensus.',
    detectedAt: '2026-06-10T18:22:00+05:30', signalSource: 'Management commentary',
  },
  {
    id: 'r5', symbol: 'TATAMOTORS', type: 'Competitive', severity: 'medium',
    title: 'EV market share erosion below 50%',
    description: 'EV share fell from 68% to under 50% in twelve months as MG, Mahindra and Hyundai scale up. EV is a valuation-narrative driver more than a current-earnings driver; multiple compression risk if share keeps sliding.',
    detectedAt: '2026-06-08T09:00:00+05:30', signalSource: 'Vahan registration data + news',
  },
  {
    id: 'r6', symbol: 'LT', type: 'Concentration', severity: 'medium',
    title: 'Rising Middle East concentration in order book',
    description: 'International orders now 38% of book, heavily Middle East hydrocarbon. Geopolitical or oil-capex shocks would hit order execution and inflows simultaneously. Diversification across verticals partly mitigates.',
    detectedAt: '2026-06-08T10:15:00+05:30', signalSource: 'Order disclosure aggregation',
  },
  {
    id: 'r7', symbol: 'HDFCLIFE', type: 'Regulatory', severity: 'medium',
    title: 'IRDAI expense-of-management draft norms',
    description: 'Stricter EoM caps from FY28 would pressure high-commission distribution. HDFC Life\'s banca-heavy mix is relatively better placed than agency-heavy peers, but VNB margin guidance may need rebasing.',
    detectedAt: '2026-06-10T14:10:00+05:30', signalSource: 'IRDAI draft circular',
  },
  {
    id: 'r8', symbol: 'SBILIFE', type: 'Regulatory', severity: 'low',
    title: 'Same IRDAI EoM exposure; strongest cost position among large insurers',
    description: 'Lowest cost ratios in the private life industry give SBI Life the most headroom under the proposed caps. Monitoring as a sector-wide item rather than a company-specific concern.',
    detectedAt: '2026-06-10T14:10:00+05:30', signalSource: 'IRDAI draft circular',
  },
  {
    id: 'r9', symbol: 'INFY', type: 'Market / Volatility', severity: 'low',
    title: 'Sector-wide IT de-rating risk despite record deal win',
    description: 'NIFTY IT down ~1% on the day and underperforming over a month. Infosys-specific news flow is positive ($2bn deal), but sector beta could dominate near term.',
    detectedAt: '2026-06-11T10:00:00+05:30', signalSource: 'Price/relative-strength anomaly',
  },
  {
    id: 'r10', symbol: 'RELIANCE', type: 'Governance', severity: 'low',
    title: 'Holding-company discount dynamics around Retail IPO',
    description: 'Retail listing crystallises subsidiary value but may also formalise a holdco discount on the parent. Structure of the offer (OFS vs fresh issue) will determine cash-flow implications.',
    detectedAt: '2026-06-11T09:00:00+05:30', signalSource: 'DRHP filing analysis',
  },
]
