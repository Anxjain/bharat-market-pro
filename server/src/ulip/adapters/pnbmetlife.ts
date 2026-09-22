// PNB MetLife adapter (IRDAI code 117) — combined monthly factsheet PDF; scrape
// the listing for the latest link. Plain fetch. AUM in crores.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'

// PNB MetLife publishes a predictable, static monthly URL — no JS listing needed:
//   .../docs/fund-update-<Year>/Met_Invest_ULIP_<Mon>_<Year>.pdf   (verified live).
const DAM = 'https://www.pnbmetlife.com/content/dam/pnb-metlife/docs'

// PNB names each file by its PUBLISH month = the data month + 1 (e.g. the
// "June 2026" file carries May-31 (2026-05) data). store() labels by the data-month
// arg, so docs() must fetch the publish-month file to keep the label correct.
// Naming is inconsistent: Jan/Feb/Mar are 3-letter, the rest are full names.
const PNB_MONTH = ['Jan', 'Feb', 'Mar', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const pnbmetlife: UlipAdapter = {
  id: 'pnbmetlife',
  irdaiCode: '117',
  name: 'PNB MetLife India Insurance',
  website: 'https://www.pnbmetlife.com',
  format: 'combined-pdf',
  aumUnit: 'crore',
  fetchMode: 'plain',
  discovery: 'direct',
  fetchHeaders: browserHeaders(),
  docs(month) {
    // publish month = data month + 1
    const [y, m] = month.split('-').map(Number)
    const pubD = new Date(Date.UTC(y, m, 1)) // m (1-based data month) as 0-based index = next month
    const pubYear = pubD.getUTCFullYear()
    const pubName = PNB_MONTH[pubD.getUTCMonth()]
    return [{
      kind: 'combined',
      filename: `pnbmetlife-${month}.pdf`,
      url: `${DAM}/fund-update-${pubYear}/Met_Invest_ULIP_${pubName}_${pubYear}.pdf`,
      refFile: month === '2026-05' ? 'pnb_june2026.pdf' : undefined,
    }]
  },
}
