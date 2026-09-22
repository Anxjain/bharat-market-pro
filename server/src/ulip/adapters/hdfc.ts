// HDFC Life adapter (IRDAI code 101) — ONE combined monthly fund factsheet PDF
// for the whole fund line-up at a stable URL; plain fetch with a browser UA.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'

export const hdfc: UlipAdapter = {
  id: 'hdfc',
  irdaiCode: '101',
  name: 'HDFC Life Insurance',
  website: 'https://www.hdfclife.com',
  format: 'combined-pdf',
  aumUnit: 'lakh', // HDFC reports AUM in INR Lakhs
  fetchMode: 'plain',
  discovery: 'direct',
  fetchHeaders: browserHeaders(),
  docs(month: string) {
    return [
      {
        kind: 'combined',
        filename: `hdfc-${month}.pdf`,
        // Stable "latest" individual-fund factsheet (verified live, ~2.2MB PDF).
        // HDFC overwrites this same URL each month, so it always serves the newest.
        url: 'https://www.hdfclife.com/content/dam/hdfclifeinsurancecompany/fund-performance/pdf/fund-factsheets-individual.pdf',
        refFile: 'hdfc_latest.pdf',
      },
    ]
  },
}
