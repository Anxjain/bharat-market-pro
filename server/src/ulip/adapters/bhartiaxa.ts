// Bharti AXA Life adapter (IRDAI code 130) — combined monthly factsheet PDF;
// scrape the listing for the latest link. Plain fetch. AUM in lakhs.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'
import { extractPdfLinks, pickLatestPdf } from '../discovery'

// Real archive page; the monthly PDF links are present in the plain HTML, so a
// listing scrape works (filenames vary month-to-month, so we match by month, not
// by a fixed pattern). e.g. .../monthly/2026-27/newsletter-and-fund-factsheet-may-2026.pdf
const LISTING = 'https://www.bhartiaxa.com/manage-funds/newsletter-and-fund-factsheet'

export const bhartiaxa: UlipAdapter = {
  id: 'bhartiaxa',
  irdaiCode: '130',
  name: 'Bharti AXA Life Insurance',
  website: 'https://www.bhartiaxa.com',
  format: 'combined-pdf',
  aumUnit: 'lakh',
  fetchMode: 'plain',
  discovery: 'listing',
  listingUrl: LISTING,
  fetchHeaders: browserHeaders(),
  docs(month) {
    return [{ kind: 'combined', filename: `bhartiaxa-${month}.pdf`, url: LISTING, refFile: month === '2026-05' ? 'bhartiaxa_may2026.pdf' : undefined }]
  },
  scrapeListing(html, month) {
    // No keyword filter: Bharti's monthly filenames are inconsistent (some say
    // "factsheet", some "combined-bharti-write-up", some just "newsletter"), so we
    // match on the inferred month instead.
    const latest = pickLatestPdf(extractPdfLinks(html, LISTING), { month })
    return latest ? [{ kind: 'combined', url: latest.url, filename: `bhartiaxa-${month}.pdf` }] : []
  },
}
