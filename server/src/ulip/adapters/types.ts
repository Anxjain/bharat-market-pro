// Per-insurer adapter contract. Each adapter is an isolated config module that
// declares how to discover + fetch its monthly source document(s) and where the
// already-downloaded reference copy lives (folder 2) for offline runs.
export interface UlipDoc {
  kind: string // 'combined' | 'fund:<slug>' — also the sources PK discriminator
  filename: string // archive filename under raw/<id>/<month>/
  url: string // direct source URL (best-effort; refined by listing scrape when applicable)
  refFile?: string // bundled reference file in folder 2 (offline fallback)
}

export interface ScrapedLink {
  kind: string
  url: string
  filename: string
}

export interface UlipAdapter {
  id: string
  irdaiCode: string // SFIN's last 3 digits must equal this
  name: string
  website: string
  format: 'combined-pdf' | 'per-fund-pdf'
  aumUnit: 'lakh' | 'crore' // unit the insurer prints AUM in (normalized to crore on store)
  fetchMode: 'plain' | 'chromium' // 'chromium' = bot-protected/tokenised (SBI, ICICI Pru)
  discovery: 'direct' | 'listing' // 'listing' = scrape the page for the LATEST link
  listingUrl?: string // page to scrape when discovery === 'listing'
  fetchHeaders?: Record<string, string>
  docs(month: string): UlipDoc[]
  // Real listing parser: given the fetched listing HTML, return the latest doc
  // link(s) for the month. Not run offline, but kept intact for live use.
  scrapeListing?(html: string, month: string): ScrapedLink[]
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const browserHeaders = (): Record<string, string> => ({ 'User-Agent': BROWSER_UA, Accept: 'application/pdf,text/html,*/*' })

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Split a 'YYYY-MM' into URL-building tokens for insurers that name PDFs by month. */
export function ymToParts(ym: string): { year: string; full: string; lower: string; abbr: string } {
  const [y, m] = ym.split('-').map(Number)
  const full = MONTH_NAMES[(m || 1) - 1]
  return { year: String(y), full, lower: full.toLowerCase(), abbr: full.slice(0, 3) }
}
