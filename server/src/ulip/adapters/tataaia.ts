// Tata AIA adapter (IRDAI code 110) — PER-FUND PDFs (one factsheet per fund). The
// full individual-fund lineup is published as static PDFs under a stable path that
// is overwritten each month, so we fetch every fund directly (no JS listing needed).
// Discovered from the rendered fact-sheet page: 22 individual funds + Assure.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'

const BASE = 'https://www.tataaia.com/content/dam/tataaialifeinsurancecompanylimited/fact-sheet/life-portfolio/individual-fund-fact-sheet-pdf'
const PDFS = `${BASE}/individual-fund-pdfs`

// Fund slugs as published (filename = <slug>.pdf). These are the "latest" copies.
const FUND_SLUGS = [
  'large-cap-equity-fund', 'multi-cap-fund', 'top-50-fund', 'top-200-fund',
  'super-select-equity-fund', 'whole-life-aggressive-growth-fund', 'whole-life-stable-growth-fund',
  'india-consumption-fund', 'emerging-opportunities-fund', 'dynamic-advantage-fund',
  'sustainable-equity-fund', 'small-cap-discovery-fund', 'rising-india-fund', 'flexi-growth-fund',
  'tax-bonanza-consumption-fund', 'midcap-momentum-index-fund', 'nifty-alpha-50-index',
  'multicap-momentum-quality-index-fund', 'momentum-50-index-fund', 'sector-leaders-index-fund',
  'whole-life-income-fund', 'whole-life-short-term-fixed-income-fund',
]

export const tataaia: UlipAdapter = {
  id: 'tataaia',
  irdaiCode: '110',
  name: 'Tata AIA Life Insurance',
  website: 'https://www.tataaia.com',
  format: 'per-fund-pdf',
  aumUnit: 'crore', // Tata AIA reports AUM in INR Crores
  fetchMode: 'plain',
  discovery: 'direct',
  fetchHeaders: browserHeaders(),
  docs(month: string) {
    const funds = FUND_SLUGS.map((slug) => ({
      kind: `fund:${slug}`,
      filename: `tataaia-${slug}-${month}.pdf`,
      url: `${PDFS}/${slug}.pdf`,
      // Keep the bundled large-cap reference as an offline fallback for that one fund.
      refFile: slug === 'large-cap-equity-fund' ? 'tataaia_largecap.pdf' : undefined,
    }))
    // Assure (debt) fund lives at the parent path, not under individual-fund-pdfs.
    funds.push({ kind: 'fund:assure-fund', filename: `tataaia-assure-fund-${month}.pdf`, url: `${BASE}/Assure-Fund.pdf`, refFile: undefined })
    return funds
  },
}
