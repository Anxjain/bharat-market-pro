// Mock news feed with pre-tagged sentiment, shaped like a news API response.
// Phase 2: replace with RSS/NewsAPI aggregation + model-based sentiment.

export type Sentiment = 'positive' | 'negative' | 'neutral'

export interface NewsItem {
  id: string
  headline: string
  source: string
  publishedAt: string // ISO
  tickers: string[]
  sector?: string
  sentiment: Sentiment
  sentimentScore: number // -1 .. +1
  summary: string
  /** 'exchange' = NSE/BSE primary disclosures (priority tier); 'press' = media. */
  tier?: 'exchange' | 'press'
  link?: string
}

export const news: NewsItem[] = [
  {
    id: 'n1', headline: 'RBI keeps repo rate unchanged at 5.50%, maintains neutral stance',
    source: 'Economic Times', publishedAt: '2026-06-11T11:05:00+05:30', tickers: ['HDFCBANK', 'ICICIBANK', 'BAJFINANCE'], sector: 'Banking',
    sentiment: 'neutral', sentimentScore: 0.05,
    summary: 'MPC voted 5-1 to hold rates; commentary suggests room for one more cut if inflation stays below 4%. Banks rallied on stable margin outlook.',
  },
  {
    id: 'n2', headline: 'Reliance Retail files draft papers for long-awaited IPO',
    source: 'Mint', publishedAt: '2026-06-11T09:40:00+05:30', tickers: ['RELIANCE'], sector: 'Energy',
    sentiment: 'positive', sentimentScore: 0.72,
    summary: 'DRHP filed with SEBI for a ₹55,000 cr issue; value unlocking catalyst the street has tracked for three years.',
  },
  {
    id: 'n3', headline: 'TCS flags delayed client decision-making in BFSI; Q1 guidance cautious',
    source: 'Business Standard', publishedAt: '2026-06-10T18:22:00+05:30', tickers: ['TCS', 'INFY'], sector: 'IT Services',
    sentiment: 'negative', sentimentScore: -0.58,
    summary: 'Management commentary points to discretionary spend pushouts in North America BFSI; deal TCV steady but revenue conversion slower.',
  },
  {
    id: 'n4', headline: 'IRDAI proposes tighter expense-of-management norms for life insurers',
    source: 'Moneycontrol', publishedAt: '2026-06-10T14:10:00+05:30', tickers: ['LICI', 'SBILIFE', 'HDFCLIFE'], sector: 'Insurance',
    sentiment: 'negative', sentimentScore: -0.41,
    summary: 'Draft circular caps EoM at stricter thresholds from FY28; high-commission channels most exposed. Industry consultation open till July.',
  },
  {
    id: 'n5', headline: 'SBI Life posts 14% APE growth in May, gains market share from LIC',
    source: 'CNBC-TV18', publishedAt: '2026-06-09T16:45:00+05:30', tickers: ['SBILIFE', 'LICI'], sector: 'Insurance',
    sentiment: 'positive', sentimentScore: 0.64,
    summary: 'Monthly business figures show private insurers outpacing; SBI Life APE +14% YoY vs industry +8%, led by non-par savings.',
  },
  {
    id: 'n6', headline: 'Bajaj Finance NBFC stress watch: RBI flags unsecured lending growth industry-wide',
    source: 'Reuters India', publishedAt: '2026-06-09T12:30:00+05:30', tickers: ['BAJFINANCE'], sector: 'NBFC',
    sentiment: 'negative', sentimentScore: -0.66,
    summary: 'Financial Stability Report highlights rising delinquencies in sub-₹50k personal loans; large NBFCs asked to stress-test books.',
  },
  {
    id: 'n7', headline: 'L&T wins ₹12,000 cr Middle East hydrocarbon order; order book at record',
    source: 'Economic Times', publishedAt: '2026-06-08T10:15:00+05:30', tickers: ['LT'], sector: 'Infrastructure',
    sentiment: 'positive', sentimentScore: 0.78,
    summary: 'Large overseas EPC win takes FY27 order inflow guidance tracking ahead of plan; international now 38% of order book.',
  },
  {
    id: 'n8', headline: 'Tata Motors EV market share slips below 50% as competition intensifies',
    source: 'Autocar Professional', publishedAt: '2026-06-08T09:00:00+05:30', tickers: ['TATAMOTORS'], sector: 'Auto',
    sentiment: 'negative', sentimentScore: -0.45,
    summary: 'MG, Mahindra and Hyundai EV launches compress Tata\'s EV share from 68% a year ago; PV margins still healthy on Nexon/Punch demand.',
  },
  {
    id: 'n9', headline: 'Star Health raises group health premiums 12% amid medical inflation',
    source: 'Mint', publishedAt: '2026-06-07T17:20:00+05:30', tickers: ['STARHEALTH'], sector: 'Insurance',
    sentiment: 'neutral', sentimentScore: 0.1,
    summary: 'Repricing aims to restore loss ratios; retention risk in price-sensitive segments is the watch item for FY27.',
  },
  {
    id: 'n10', headline: 'ICICI Lombard motor segment combined ratio improves to 101.8%',
    source: 'Business Standard', publishedAt: '2026-06-07T11:50:00+05:30', tickers: ['ICICIGI'], sector: 'Insurance',
    sentiment: 'positive', sentimentScore: 0.52,
    summary: 'Better claims experience and pricing discipline in motor OD; health retail book growing 24% YoY.',
  },
  {
    id: 'n11', headline: 'Sun Pharma specialty drug Ilumya posts strong US scripts; FY27 guidance raised',
    source: 'CNBC-TV18', publishedAt: '2026-06-06T15:35:00+05:30', tickers: ['SUNPHARMA'], sector: 'Pharma',
    sentiment: 'positive', sentimentScore: 0.61,
    summary: 'Specialty revenue run-rate crosses $1.4bn annualised; management raises FY27 specialty growth outlook to mid-teens.',
  },
  {
    id: 'n12', headline: 'ITC hotels demerger record date set; FMCG margins steady despite input costs',
    source: 'Economic Times', publishedAt: '2026-06-06T10:05:00+05:30', tickers: ['ITC'], sector: 'FMCG',
    sentiment: 'neutral', sentimentScore: 0.15,
    summary: 'Corporate action housekeeping continues; cigarette volume growth of 4% YoY remains the earnings anchor.',
  },
  {
    id: 'n13', headline: 'HDFC Bank CASA ratio recovers to 38%; deposit war easing, says management',
    source: 'Moneycontrol', publishedAt: '2026-06-05T14:25:00+05:30', tickers: ['HDFCBANK'], sector: 'Banking',
    sentiment: 'positive', sentimentScore: 0.55,
    summary: 'Post-merger balance sheet normalisation on track; LDR down to 98% from 110% peak, NIM guidance maintained.',
  },
  {
    id: 'n14', headline: 'Infosys announces $2bn AI-led deal with European bank, largest ever TCV',
    source: 'Reuters India', publishedAt: '2026-06-05T09:10:00+05:30', tickers: ['INFY'], sector: 'IT Services',
    sentiment: 'positive', sentimentScore: 0.69,
    summary: 'Multi-year transformation deal anchored on Topaz AI platform; partially offsets weak discretionary spending narrative.',
  },
  {
    id: 'n15', headline: 'LIC embedded value review: analysts split on assumption changes',
    source: 'Mint', publishedAt: '2026-06-04T16:00:00+05:30', tickers: ['LICI'], sector: 'Insurance',
    sentiment: 'neutral', sentimentScore: -0.08,
    summary: 'EV grew 6% YoY but persistency assumptions loosened; bulls cite valuation discount, bears cite market-share drift to private players.',
  },
  {
    id: 'n16', headline: 'Government mulls composite insurance licences in Insurance Amendment Bill',
    source: 'Business Standard', publishedAt: '2026-06-04T11:30:00+05:30', tickers: ['LICI', 'SBILIFE', 'HDFCLIFE', 'ICICIGI', 'STARHEALTH'], sector: 'Insurance',
    sentiment: 'positive', sentimentScore: 0.48,
    summary: 'Composite licences would let life insurers sell health products; seen as long-term growth optionality for large players.',
  },
]
