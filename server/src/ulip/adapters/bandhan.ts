// Bandhan Life adapter (IRDAI code 138, formerly Aegon Life) — combined monthly
// factsheet PDF; scrape the listing for the latest link. Plain fetch.
// CODE-ONLY: no bundled reference PDF in folder 2, so offline runs record a gap.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'
import { extractPdfLinks, pickLatestPdf } from '../discovery'

// Canonical source: the JS-rendered "Investment Details" page lists the monthly
// "InDepth" factsheet PDFs (inconsistent filenames + a tokenised path), so render
// with Chromium and pick the latest "InDepth" link for the month.
const LISTING = 'https://www.bandhanlife.com/fund-performance/investment-details'

export const bandhan: UlipAdapter = {
  id: 'bandhan',
  irdaiCode: '138',
  name: 'Bandhan Life Insurance',
  website: 'https://www.bandhanlife.com',
  format: 'combined-pdf',
  aumUnit: 'crore', // InDepth factsheet prints AUM in crore ("110.06 Cr")
  fetchMode: 'chromium',
  discovery: 'listing',
  listingUrl: LISTING,
  fetchHeaders: browserHeaders(),
  docs(month) {
    return [{ kind: 'combined', filename: `bandhan-${month}.pdf`, url: LISTING }]
  },
  scrapeListing(html, month) {
    const latest = pickLatestPdf(extractPdfLinks(html, LISTING), { month, keyword: 'indepth' })
    return latest ? [{ kind: 'combined', url: latest.url, filename: `bandhan-${month}.pdf` }] : []
  },
}
