// SBI Life adapter (IRDAI code 111) — combined monthly factsheet PDF behind a
// bot-protected/tokenised site, so fetch via headless Chromium. AUM in crores.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'
import { extractPdfLinks, pickLatestPdf } from '../discovery'

// Canonical source: the "ULIP Newsletters" download centre (JS-rendered list of
// monthly "SBI LIFE ULIP NEWS LETTER <MONTH> <YEAR>.pdf" docs with tokenised URLs).
const LISTING = 'https://www.sbilife.co.in/customer-services/download-centre/ulip-newsletters?category=21587756'

export const sbi: UlipAdapter = {
  id: 'sbi',
  irdaiCode: '111',
  name: 'SBI Life Insurance',
  website: 'https://www.sbilife.co.in',
  format: 'combined-pdf',
  aumUnit: 'crore',
  fetchMode: 'chromium',
  discovery: 'listing',
  listingUrl: LISTING,
  fetchHeaders: browserHeaders(),
  docs(month) {
    return [{ kind: 'combined', filename: `sbi-${month}.pdf`, url: LISTING, refFile: month === '2026-05' ? 'sbi_ulip_may2026.pdf' : undefined }]
  },
  scrapeListing(html, month) {
    // Match the ULIP (not GROUP) newsletter for the target month.
    const latest = pickLatestPdf(extractPdfLinks(html, LISTING), { month, keyword: 'ulip' })
    return latest ? [{ kind: 'combined', url: latest.url, filename: `sbi-${month}.pdf` }] : []
  },
}
