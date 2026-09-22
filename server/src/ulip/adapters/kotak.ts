// Kotak Mahindra Life adapter (IRDAI code 107) — combined monthly factsheet PDF;
// scrape the listing page for the latest link. Plain fetch. AUM printed in lakhs.
// Three reference months (Mar/Apr/May 2026) are bundled for offline backfill.
import type { UlipAdapter } from './types'
import { browserHeaders, ymToParts } from './types'

// Kotak overwrites a predictable, static monthly URL — no JS listing needed:
//   .../pdfs/Kotak_Life_Individual_<Month>_<Year>.pdf   (verified live).
const PDF_BASE = 'https://www.kotaklife.com/assets/images/uploads/fund-performance/pdfs'
const REF: Record<string, string> = {
  '2026-03': 'kotak_March_2026.pdf',
  '2026-04': 'kotak_April_2026.pdf',
  '2026-05': 'kotak_May_2026.pdf',
}

export const kotak: UlipAdapter = {
  id: 'kotak',
  irdaiCode: '107',
  name: 'Kotak Mahindra Life Insurance',
  website: 'https://www.kotaklife.com',
  format: 'combined-pdf',
  aumUnit: 'lakh',
  fetchMode: 'plain',
  discovery: 'direct',
  fetchHeaders: browserHeaders(),
  docs(month) {
    const { full, year } = ymToParts(month)
    return [{
      kind: 'combined',
      filename: `kotak-${month}.pdf`,
      url: `${PDF_BASE}/Kotak_Life_Individual_${full}_${year}.pdf`,
      refFile: REF[month],
    }]
  },
}
