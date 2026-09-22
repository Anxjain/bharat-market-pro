// Canara HSBC Life adapter (IRDAI code 136) — monthly "Investment Newsletter" PDF
// (combined factsheet). Current month at a stable latest-newsletter path; older
// months live under numbered archive folders (enumerate via the listing page).
// AUM printed in INR Crore.
import type { UlipAdapter } from './types'
import { browserHeaders } from './types'

const DAM = 'https://www.canarahsbclife.com/content/dam/chli/pdf/investment-newsletter'
const MONTH = ['january','february','march','april','may','june','july','august','september','october','november','december']

export const canarahsbc: UlipAdapter = {
  id: 'canarahsbc',
  irdaiCode: '136',
  name: 'Canara HSBC Life Insurance',
  website: 'https://www.canarahsbclife.com',
  format: 'combined-pdf',
  aumUnit: 'crore',
  fetchMode: 'plain',
  discovery: 'direct',
  fetchHeaders: browserHeaders(),
  docs(month) {
    const [y, m] = month.split('-').map(Number)
    const name = MONTH[m - 1]
    return [{
      kind: 'combined',
      filename: `canarahsbc-${month}.pdf`,
      url: `${DAM}/latest-newsletter/${y}/investment-newsletter-${name}-${y}.pdf`,
    }]
  },
}
