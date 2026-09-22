// Shriram Life adapter (IRDAI code 128) — monthly combined factsheet PDF hosted on
// a CDN with a per-file VersionId query string, so the live URL must be discovered
// from the nav-history page (no constructible pattern). AUM printed in INR Crore.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'
import { extractPdfLinks, pickLatestPdf } from '../discovery'

const LISTING = 'https://www.shriramlife.com/services/nav-history'

export const shriram: UlipAdapter = {
  id: 'shriram',
  irdaiCode: '128',
  name: 'Shriram Life Insurance',
  website: 'https://www.shriramlife.com',
  format: 'combined-pdf',
  aumUnit: 'crore',
  fetchMode: 'plain',
  discovery: 'listing',
  listingUrl: LISTING,
  fetchHeaders: browserHeaders(),
  docs(month) {
    return [{ kind: 'combined', filename: `shriram-${month}.pdf`, url: LISTING }]
  },
  scrapeListing(html, month) {
    const latest = pickLatestPdf(extractPdfLinks(html, LISTING), { month, keyword: 'factsheet' })
    return latest ? [{ kind: 'combined', url: latest.url, filename: `shriram-${month}.pdf` }] : []
  },
}
