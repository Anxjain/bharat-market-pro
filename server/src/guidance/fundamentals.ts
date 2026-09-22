// Business-fundamentals engine for the guidance desk — the "is this worth owning at all?"
// axis, kept SEPARATE from the price/timing axis. Sources everything from screener.in
// (which the tool already scrapes), including screener's own pre-computed compounded
// growth, ROE and CFO/OP figures. Produces four blocks — Quality, Financial health,
// Valuation, Risk penalty (+ a light bank overlay) — combined into a 0–100 business-
// quality score with an explainable point list per block. All thresholds are tunable.
import * as fundRepo from '../repositories/guidanceFundamentals'

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }

export interface Block {
  score: number // normalized [-1,+1]
  points: string[] // human "why", e.g. "3Y profit CAGR 18% (+1)"
}
export interface Fundamentals {
  symbol: string
  isBank: boolean
  asOf: string
  // headline metrics (many read straight from screener's pre-computed blocks)
  salesCagr3y: number | null
  salesCagr5y: number | null
  profitCagr3y: number | null
  profitCagr5y: number | null
  roe3y: number | null
  roe5y: number | null
  roceLatest: number | null
  marginNow: number | null
  marginTrend: 'improving' | 'flat' | 'deteriorating' | null
  debtToEquity: number | null
  debtToEquityPrev: number | null
  interestCoverage: number | null
  cfoToOp: number | null // screener's CFO/OP (cash-flow quality)
  pe: number | null
  peg: number | null
  pb: number | null
  divYield: number | null
  bankNpaFound: boolean
  // scoring
  quality: Block
  health: Block
  valuation: Block
  risk: Block & { forceAvoid: boolean }
  qualityScore: number // 0–100 business-quality axis (quality + health + valuation, penalised by risk)
  qualityTier: 'excellent' | 'good' | 'fair' | 'weak'
  note: string
}

function num(cell: string | undefined): number | null {
  if (!cell) return null
  const m = cell.replace(/,/g, '').replace(/[₹%]/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
function clamp(x: number, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, x)) }
function round1(n: number | null) { return n == null ? null : Math.round(n * 10) / 10 }

// Section table (headers = years, rows = metric label + yearly values).
function sectionRows(html: string, id: string): { label: string; vals: number[] }[] {
  const s = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))
  if (!s) return []
  const out: { label: string; vals: number[] }[] = []
  for (const tr of s[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    if (cells.length < 2) continue
    out.push({ label: cells[0], vals: cells.slice(1).map((c) => (num(c) ?? NaN)) })
  }
  return out
}
// M-G9: keep NaN placeholders — do NOT filter blank cells. Filtering collapsed each row to
// a different length, so `row[i]` referred to a DIFFERENT fiscal year per row and
// debtToEquity(Prev) compared mismatched years (spurious `debtSpike` force-avoids). With the
// blanks preserved, column index == the same year across every balance-sheet/P&L row.
function findRow(rows: { label: string; vals: number[] }[], re: RegExp): number[] | null {
  const r = rows.find((x) => re.test(x.label))
  return r ? r.vals : null
}
/** The most recent FINITE value in a year-aligned row (blanks kept as NaN). */
function lastFinite(vals: number[] | null): number | null {
  if (!vals) return null
  for (let i = vals.length - 1; i >= 0; i--) if (Number.isFinite(vals[i])) return vals[i]
  return null
}
/** Sum ignoring NaN placeholders (blank cells). */
function finiteSum(vals: number[]): number {
  return vals.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
}

// screener's "ranges-table" blocks (Compounded Sales/Profit Growth, ROE) — pre-computed.
function rangesTables(html: string): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {}
  for (const t of html.matchAll(/<table class="ranges-table">([\s\S]*?)<\/table>/g)) {
    const block = t[1]
    const heading = (block.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!heading) continue
    const map: Record<string, number | null> = {}
    for (const r of block.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
      const k = r[1].replace(/<[^>]+>/g, '').replace(/:/g, '').replace(/\s+/g, ' ').trim()
      map[k] = num(r[2])
    }
    out[heading] = map
  }
  return out
}

// top-ratios list (current P/E, ROE, Book Value, Dividend Yield, Market Cap, Debt...).
function topRatios(html: string): Record<string, number | null> {
  const block = html.match(/<ul[^>]*id="top-ratios"[^>]*>([\s\S]*?)<\/ul>/)
  const scope = block ? block[1] : html
  const out: Record<string, number | null> = {}
  for (const li of scope.matchAll(/<span class="name">([\s\S]*?)<\/span>([\s\S]*?)<\/li>/g)) {
    const label = li[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    out[label] = num(li[2].replace(/<[^>]+>/g, ' '))
  }
  return out
}

async function fetchHtml(symbol: string): Promise<string | null> {
  for (const url of [`https://www.screener.in/company/${symbol}/consolidated/`, `https://www.screener.in/company/${symbol}/`]) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      // M-G8: detect rate-limiting / bot walls and back off instead of hammering + parsing junk.
      if (res.status === 429 || res.status === 503) {
        console.warn(`[guidance:fundamentals] ${symbol}: HTTP ${res.status} (rate-limited) — backing off`)
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      if (res.ok) {
        const html = await res.text()
        if (/captcha|unusual traffic|are you a robot|verify you are human/i.test(html)) {
          console.warn(`[guidance:fundamentals] ${symbol}: captcha/interstitial served — treating as a miss`)
          return null
        }
        if (/id="profit-loss"/.test(html)) return html
      }
    } catch { /* next */ }
  }
  return null
}

// ——— block scoring (their +1/-1 framework, normalised to [-1,+1]) ———
function score(points: (readonly [boolean, string, number])[]): Block {
  const chosen = points.filter(([cond]) => cond)
  const pts = chosen.map(([, label, w]) => `${label} (${w >= 0 ? '+' : ''}${w})`)
  const raw = points.reduce((a, [cond, , w]) => a + (cond ? w : 0), 0)
  const maxPos = points.filter(([, , w]) => w > 0).reduce((a, [, , w]) => a + w, 0) || 1
  return { score: clamp(raw / maxPos), points: pts.length ? pts : ['no strong signals'] }
}

export function scoreFundamentals(f: Omit<Fundamentals, 'quality' | 'health' | 'valuation' | 'risk' | 'qualityScore' | 'qualityTier'>): Fundamentals {
  const isBank = f.isBank
  // Quality — growth + margin behaviour
  const quality = score([
    [f.salesCagr3y != null && f.salesCagr3y > 10, `3Y sales growth ${round1(f.salesCagr3y)}%`, 1],
    [f.profitCagr3y != null && f.profitCagr3y > 12, `3Y profit growth ${round1(f.profitCagr3y)}%`, 1],
    [f.profitCagr5y != null && f.profitCagr5y > 10, `5Y profit growth ${round1(f.profitCagr5y)}%`, 1],
    [f.marginTrend === 'improving' || f.marginTrend === 'flat', `margins ${f.marginTrend}`, 1],
    [f.profitCagr3y != null && f.profitCagr3y < 0, `profit shrinking (3Y ${round1(f.profitCagr3y)}%)`, -2],
    [f.marginTrend === 'deteriorating', 'margins deteriorating', -1],
  ])
  // Financial health — returns, leverage, coverage, cash
  const health = score([
    [f.roe3y != null && f.roe3y > 15, `3Y ROE ${round1(f.roe3y)}%`, 1],
    [!isBank && f.roceLatest != null && f.roceLatest > 15, `ROCE ${round1(f.roceLatest)}%`, 1],
    [!isBank && f.debtToEquity != null && f.debtToEquity < 1, `low debt (D/E ${round1(f.debtToEquity)})`, 1],
    [!isBank && f.interestCoverage != null && f.interestCoverage > 3, `interest cover ${round1(f.interestCoverage)}x`, 1],
    [f.cfoToOp != null && f.cfoToOp > 0.6, `cash-backed profits (CFO/OP ${round1(f.cfoToOp)})`, 1],
    [f.roe3y != null && f.roe3y < 8, `weak ROE ${round1(f.roe3y)}%`, -1],
    [!isBank && f.debtToEquity != null && f.debtToEquityPrev != null && f.debtToEquity > 1.5 && f.debtToEquity > f.debtToEquityPrev * 1.3, 'debt spiking', -2],
  ])
  // Valuation — is the price sensible for that quality
  const valuation = score([
    [f.peg != null && f.peg >= 0.4 && f.peg <= 1.5, `PEG ${round1(f.peg)} (fair)`, 1],
    [f.pe != null && f.pe > 0 && f.pe < 22, `P/E ${round1(f.pe)} (reasonable)`, 1],
    [isBank && f.pb != null && f.pb < 2 && (f.roe3y ?? 0) > 13, `P/B ${round1(f.pb)} vs ROE ${round1(f.roe3y)}%`, 1],
    [f.divYield != null && f.divYield > 2, `dividend yield ${round1(f.divYield)}%`, 0.5],
    [f.pe != null && f.pe > 60, `expensive (P/E ${round1(f.pe)})`, -1],
    [f.peg != null && f.peg > 3, `PEG ${round1(f.peg)} (stretched)`, -1],
  ])
  // Risk penalty — can force "do not recommend"
  // H-12: EXEMPT banks from the negative-operating-cash-flow check. Growing banks routinely
  // run negative operating cash flow (loan-book growth consumes cash), so scoring/force-
  // avoiding on it wrongly flagged healthy banks — ~40% of the seeded watchlist — as "avoid".
  const negCfo = !isBank && f.cfoToOp != null && f.cfoToOp < 0
  const debtSpike = !isBank && f.debtToEquity != null && f.debtToEquityPrev != null && f.debtToEquity > 2 && f.debtToEquity > f.debtToEquityPrev * 1.4
  const lowCover = !isBank && f.interestCoverage != null && f.interestCoverage < 1.5
  const risk: Block & { forceAvoid: boolean } = {
    ...score([
      [negCfo, 'operating cash flow negative vs profits', -3],
      [debtSpike, 'debt sharply rising', -2],
      [lowCover, `interest cover only ${round1(f.interestCoverage)}x`, -2],
    ]),
    forceAvoid: negCfo || (debtSpike && lowCover),
  }

  // Business-quality axis: quality + health + valuation, penalised by risk. → 0–100.
  const base = (quality.score * 1.1 + health.score * 1.1 + valuation.score * 0.8) / 3
  const penalised = clamp(base + Math.min(0, risk.score * 0.5))
  const qualityScore = Math.round(((penalised + 1) / 2) * 100)
  const qualityTier: Fundamentals['qualityTier'] = risk.forceAvoid ? 'weak' : qualityScore >= 70 ? 'excellent' : qualityScore >= 52 ? 'good' : qualityScore >= 36 ? 'fair' : 'weak'

  return { ...f, quality, health, valuation, risk, qualityScore, qualityTier }
}

export async function fetchFundamentals(symbol: string): Promise<Fundamentals | null> {
  const sym = symbol.toUpperCase()
  const html = await fetchHtml(sym)
  if (!html) return null

  const pl = sectionRows(html, 'profit-loss')
  const bs = sectionRows(html, 'balance-sheet')
  const cf = sectionRows(html, 'cash-flow')
  const ratios = sectionRows(html, 'ratios')
  const rt = rangesTables(html)
  const top = topRatios(html)

  // M-G8: alert when the page loaded but every block parsed empty — a strong signal that
  // screener's layout changed (or a soft-block page was served) rather than a real miss.
  if (!pl.length && !bs.length && !cf.length && !Object.keys(rt).length && !Object.keys(top).length) {
    console.warn(`[guidance:fundamentals] ${sym}: page fetched but ALL blocks parsed empty — screener layout may have changed`)
    return null
  }

  const isBank = pl.some((r) => /financing profit|financing margin/i.test(r.label)) || bs.some((r) => /^deposits/i.test(r.label))

  const g = (heading: string, period: string) => rt[heading]?.[period] ?? null
  const salesCagr3y = g('Compounded Sales Growth', '3 Years')
  const salesCagr5y = g('Compounded Sales Growth', '5 Years')
  const profitCagr3y = g('Compounded Profit Growth', '3 Years')
  const profitCagr5y = g('Compounded Profit Growth', '5 Years')
  const roe3y = g('Return on Equity', '3 Years')
  const roe5y = g('Return on Equity', '5 Years')

  const roceRow = findRow(ratios, /ROCE/i)
  const roceLatest = lastFinite(roceRow) ?? top['roce'] ?? top['roce %'] ?? null

  // Margin trend from OPM% (non-bank only — a bank's "Financing Margin %" is not a
  // comparable operating margin, so we don't score margin trend for banks). Year-aligned:
  // blanks are NaN placeholders, so index n-1 and n-4 are the same-labelled columns.
  const marginRow = isBank ? null : findRow(pl, /OPM ?%/i)
  let marginNow: number | null = null
  let marginTrend: Fundamentals['marginTrend'] = null
  if (marginRow && marginRow.length >= 4) {
    const cur = marginRow[marginRow.length - 1]
    const past = marginRow[marginRow.length - 4] // ~3y ago (same-year alignment)
    if (Number.isFinite(cur) && Number.isFinite(past)) {
      marginNow = cur
      const d = cur - past
      marginTrend = d > 1.5 ? 'improving' : d < -1.5 ? 'deteriorating' : 'flat'
    } else {
      marginNow = lastFinite(marginRow)
    }
  }

  // Leverage from balance sheet: Borrowings / (Equity + Reserves). Banks fund via deposits,
  // so a high D/E is structural — computed but not penalised for banks. M-G9: pick the latest
  // COLUMN where borrowings + net worth are both finite, and compare the prior year at the
  // aligned column (li-3), so D/E(now) and D/E(prev) are the same-year comparisons.
  const equity = findRow(bs, /^equity capital/i)
  const reserves = findRow(bs, /^reserves/i)
  const borrow = findRow(bs, /^borrowing/i)
  const netWorth = (i: number): number | null => {
    if (!equity || !reserves) return null
    const e = equity[i]; const r = reserves[i]
    if (!Number.isFinite(e) || !Number.isFinite(r)) return null
    return e + r
  }
  let debtToEquity: number | null = null
  let debtToEquityPrev: number | null = null
  if (borrow && borrow.length) {
    let li = -1
    for (let i = borrow.length - 1; i >= 0; i--) {
      const nw = netWorth(i)
      if (Number.isFinite(borrow[i]) && nw && nw !== 0) { li = i; break }
    }
    if (li >= 0) {
      debtToEquity = round1(borrow[li] / netWorth(li)!)
      const pi = li - 3
      if (pi >= 0) { const pnw = netWorth(pi); if (pnw && pnw !== 0 && Number.isFinite(borrow[pi])) debtToEquityPrev = round1(borrow[pi] / pnw) }
    }
  }

  // Interest coverage (non-bank): Operating Profit / Interest, latest year (last finite).
  const opRow = findRow(pl, /^operating profit/i)
  const intRow = findRow(pl, /^interest/i)
  let interestCoverage: number | null = null
  if (!isBank) {
    const op = lastFinite(opRow); const it = lastFinite(intRow)
    if (op != null && it != null && it > 0) interestCoverage = round1(op / it)
  }

  // Cash-flow quality — screener's CFO/OP row (else compute CFO sum / PAT sum). H-12: for
  // BANKS we only trust a real CFO/OP row and never the CFO/PAT fallback — a bank's operating
  // cash flow swings with loan-book growth, so CFO/PAT is not a meaningful quality signal.
  const cfoOpRow = findRow(cf, /CFO\/OP/i)
  let cfoToOp = lastFinite(cfoOpRow)
  if (cfoToOp == null && !isBank) {
    const cfo = findRow(cf, /operating activit/i)
    const pat = findRow(pl, /^net profit/i)
    if (cfo && pat) { const a = finiteSum(cfo.slice(-3)); const b = finiteSum(pat.slice(-3)); if (b) cfoToOp = round1(a / b) }
  }

  const pe = top['stock p/e'] ?? top['p/e'] ?? top['price to earning'] ?? null
  const bookValue = top['book value'] ?? null
  const price = top['current price'] ?? null
  const pb = bookValue && price ? round1(price / bookValue) : (top['price to book'] ?? null)
  const divYield = top['dividend yield'] ?? null
  const peg = pe != null && profitCagr3y != null && profitCagr3y > 0 ? round1(pe / profitCagr3y) : null

  const partial: Omit<Fundamentals, 'quality' | 'health' | 'valuation' | 'risk' | 'qualityScore' | 'qualityTier'> = {
    symbol: sym, isBank, asOf: new Date().toISOString(),
    salesCagr3y, salesCagr5y, profitCagr3y, profitCagr5y, roe3y, roe5y, roceLatest,
    marginNow, marginTrend, debtToEquity, debtToEquityPrev, interestCoverage, cfoToOp,
    pe, peg, pb, divYield,
    bankNpaFound: false, // screener's standard sections don't expose GNPA/NNPA/NIM reliably
    note: isBank ? 'Bank: leverage is deposit-funded (not penalised); asset-quality (GNPA/NNPA/NIM) not available from this source.' : '',
  }
  return scoreFundamentals(partial)
}

const cache = new Map<string, { data: Fundamentals | null; at: number }>()
const MEM_TTL = 60 * 60 * 1000
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000 // fundamentals change quarterly → refresh weekly

/** DB-first business fundamentals: accumulates, survives restarts, last-good on failure. */
export async function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.at < MEM_TTL) return hit.data

  const stored = await fundRepo.get<Fundamentals>(sym).catch(() => null)
  if (stored && Date.now() - Date.parse(stored.updatedAt) < REFRESH_MS) {
    cache.set(sym, { data: stored.json, at: Date.now() })
    return stored.json
  }

  const fresh = await fetchFundamentals(sym).catch(() => null)
  if (fresh) {
    await fundRepo.set(sym, fresh).catch(() => {})
    // M-G6: also APPEND to guidance_fundamentals_history so a real fundamentals time-series
    // accumulates (the symbol-keyed `guidance_fundamentals` upsert overwrites the prior
    // snapshot). Best-effort — swallow until the table/migration lands (see report).
    await fundRepo.appendHistory(sym, fresh.asOf, fresh).catch(() => {})
    cache.set(sym, { data: fresh, at: Date.now() })
    return fresh
  }
  // Fetch failed → serve last-good, but mark it stale so the UI can show the as-of age (M-G8).
  if (stored) {
    const stale: Fundamentals = { ...stored.json, note: `${stored.json.note ? stored.json.note + ' ' : ''}⚠ Live refresh failed — showing last-good data as of ${stored.json.asOf.slice(0, 10)}.` }
    cache.set(sym, { data: stale, at: Date.now() })
    return stale
  }
  cache.set(sym, { data: null, at: Date.now() })
  return null
}
