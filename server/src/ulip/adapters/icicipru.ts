// ICICI Prudential Life adapter (IRDAI code 105).
//
// NOTE: ICICI is NOT ingested via this PDF adapter anymore — the returns-only PDF has no
// holdings. Its full data (holdings + sector + asset mix + returns) comes from ICICI's
// JSON web API and is handled by `server/src/ulip/icici-web.ts` (run: `npm run ulip:icici`,
// and it's called from monthlyUlipFetch). This adapter object is kept only so `store()`
// can reuse its irdaiCode/aumUnit config. Do not add icicipru to the PDF pipeline loop.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'

// Canonical landing (for reference/discovery); the combined PDF is the fetch target.
const LANDING = 'https://www.iciciprulife.com/fund-performance/all-products-fund-performance-details.html'
const COMBINED_PDF = 'https://www.iciciprulife.com/content/dam/icicipru/fund-performance/pdf/Fund_Performance_Details.pdf'

export const icicipru: UlipAdapter = {
  id: 'icicipru',
  irdaiCode: '105',
  name: 'ICICI Prudential Life Insurance',
  website: 'https://www.iciciprulife.com',
  format: 'combined-pdf',
  aumUnit: 'crore',
  fetchMode: 'chromium', // DAM PDF is bot-blocked for plain fetch
  discovery: 'direct',
  listingUrl: LANDING,
  fetchHeaders: browserHeaders(),
  docs() {
    // The combined PDF is overwritten in place each cycle, so the same URL always
    // serves the newest NAV+returns table (one combined doc, not per-month).
    return [{ kind: 'performance', filename: `icicipru-performance.pdf`, url: COMBINED_PDF }]
  },
}
