// ICICI Prudential Life (IRDAI 105) — WEB-API ingestion. ICICI does NOT publish a
// portfolio PDF; its fund data lives behind clean JSON endpoints on buy.iciciprulife.com
// (discovered from the fund-performance site). This is the ONLY insurer we ingest via API
// rather than PDF, so it gets a dedicated module instead of the PDF pipeline.
//
// Endpoints (all GET, JSON):
//   • funds-all-products.htm?startDate&endDate  → every fund: SFIN, LAfundCode, NAV, returns
//   • funds-portfolio-details.htm?fundCode=<LAfundCode> → holdings (company/corporate/govt/
//     fd/current-asset lists), SectorList, fundcomposition (asset mix + AUM), rating buckets,
//     Portfolio_by_maturity, YTM_And_Modified_Duration
//
// The result is mapped to the standard ExtractedFund contract and written through the
// shared store() (validation + transactional per-fund write), then each fund's source-link
// is pointed at its live portfolio page so "source factsheet" opens the exact fund.
import { icicipru } from './adapters/icicipru'
import { store } from './store'
import { normalizeSfin, type ExtractedFund } from './types'
import { openApiSession, type ApiSession } from './browser'
import { db } from '../db/client'
import { funds as fundsTable } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import * as sourcesRepo from '../repositories/sources'

const BASE = 'https://buy.iciciprulife.com/buy'
const SITE = 'https://www.iciciprulife.com/fund-performance'
const LANDING = 'https://www.iciciprulife.com/fund-performance/all-products-fund-performance-details.html'
const INSURER = '105'

// ——— parsing helpers ———
const pct = (s: unknown): number | null => {
  if (s == null) return null
  const t = String(s).replace('%', '').trim()
  if (!t || /^na$/i.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
const numOrNull = (s: unknown): number | null => {
  if (s == null) return null
  const n = Number(String(s).trim())
  return Number.isFinite(n) ? n : null
}
/** "Maximum 100% and Minimum 80%" → { min: 80, max: 100 }. */
function fuBand(limits: string | undefined): { min: number | null; max: number | null } {
  if (!limits) return { min: null, max: null }
  const max = limits.match(/Maximum\s*(\d+(?:\.\d+)?)/i)
  const min = limits.match(/Minimum\s*(\d+(?:\.\d+)?)/i)
  return { min: min ? Number(min[1]) : null, max: max ? Number(max[1]) : null }
}
/** ddMonyyyy US-ish "Jun 4, 2026 …" → YYYY-MM of the PRIOR month (disclosure month).
 *  Returns null when crteDate is missing/unparseable — the caller must NOT silently
 *  fall back to today (that mislabels every fund in the run; audit fix 2026-07-14). */
function disclosureMonthFrom(crteDate: string | undefined): string | null {
  if (!crteDate) return null
  const d = new Date(crteDate)
  if (Number.isNaN(d.getTime())) return null
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Month consensus across the fund list — a single row's bad crteDate can't set the label. */
function consensusMonth(list: { crteDate?: string }[]): string | null {
  const counts = new Map<string, number>()
  for (const row of list.slice(0, 30)) {
    const m = disclosureMonthFrom(row.crteDate)
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n }
  return best
}

async function getJson<T>(session: ApiSession, url: string, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t = (await session.fetchText(url)).trim()
    if (t && !t.startsWith('<')) return JSON.parse(t) as T
    if (attempt >= retries) throw new Error(`non-JSON (WAF/HTML) for ${url}`)
    await new Promise((r) => setTimeout(r, 2500)) // let the _abck cookie settle, then retry
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface AllProductRow {
  LAfundCode: string; Fund: string; SFIN: string; AssetClass: string
  Perf1Month: string; Perf6Month: string; Perf1Year: string; Perf2Year: string; Perf3Year: string
  Perf4Year: string; Perf5Year: string; Perf7Year: string; Perf10Year: string; PerfInception: string
  InceptionDate: string; NAVLatest: string; crteDate: string; NAVLatestDate: string
}
interface Holding { company: string; companyrating: string; investedpercent: string }
interface PortfolioResp {
  company_list?: Holding[]; corporate_list?: Holding[]; goverment_list?: Holding[]
  fd_list?: Holding[]; currentassets_list?: Holding[]; dbtMoneyMarketCrntAsset_list?: Holding[]
  SectorList?: { sector: string; investedpercent: string }[]
  fundcomposition?: { assetmix: string; limits: string; composition: string; AUM: string }[]
  Corporate_Securities?: { rating: string; value: string }[]
  Corporate_Money_Market_Securities?: { rating: string; value: string }[]
  Portfolio_by_maturity?: { Year: string; Value: string }[]
  YTM_And_Modified_Duration?: { name: string; value: string }[]
}

const PERIODS: [keyof AllProductRow, string][] = [
  ['Perf1Month', '1M'], ['Perf6Month', '6M'], ['Perf1Year', '1Y'], ['Perf2Year', '2Y'],
  ['Perf3Year', '3Y'], ['Perf4Year', '4Y'], ['Perf5Year', '5Y'], ['Perf7Year', '7Y'],
  ['Perf10Year', '10Y'], ['PerfInception', 'Inception'],
]

const HOLDING_CATEGORIES: [keyof PortfolioResp, string][] = [
  ['company_list', 'Equity'],
  ['corporate_list', 'Corporate Debt'],
  ['goverment_list', 'Government Securities'],
  ['fd_list', 'Fixed Deposit'],
  ['dbtMoneyMarketCrntAsset_list', 'Money Market'],
  ['currentassets_list', 'Money Market & Cash'],
]

function toExtractedFund(row: AllProductRow, p: PortfolioResp): ExtractedFund {
  // Returns from the all-products row.
  const returns = PERIODS.map(([k, period]) => ({ period, returnPct: pct(row[k]), benchmarkPct: null }))

  // Holdings across every category list.
  const holdings: ExtractedFund['holdings'] = []
  for (const [key, category] of HOLDING_CATEGORIES) {
    for (const h of (p[key] as Holding[] | undefined) ?? []) {
      if (!h.company) continue
      holdings.push({
        security: h.company,
        weightPct: pct(h.investedpercent),
        category,
        rawCategory: category,
        isin: null,
        rating: h.companyrating && h.companyrating !== '0' ? h.companyrating : null,
        marketValue: null,
      })
    }
  }

  // Allocations: asset mix (with F&U bands + AUM split), sector, rating buckets, maturity.
  const allocations: ExtractedFund['allocations'] = []
  let aumEquity: number | null = null, aumDebt: number | null = null, aumMmi: number | null = null
  for (const c of p.fundcomposition ?? []) {
    const band = fuBand(c.limits)
    allocations.push({ kind: 'asset', label: c.assetmix, weight: pct(c.composition), fuMin: band.min, fuMax: band.max })
    const aumCr = c.AUM != null ? Number(c.AUM) / 1e7 : null // rupees → crore
    if (/equity/i.test(c.assetmix)) aumEquity = aumCr
    else if (/debt/i.test(c.assetmix)) aumDebt = aumCr
    else if (/money market|cash/i.test(c.assetmix)) aumMmi = aumCr
  }
  for (const s of p.SectorList ?? []) allocations.push({ kind: 'sector', label: s.sector, weight: pct(s.investedpercent) })
  for (const r of [...(p.Corporate_Securities ?? []), ...(p.Corporate_Money_Market_Securities ?? [])])
    allocations.push({ kind: 'rating', label: r.rating, weight: numOrNull(r.value) })
  for (const m of p.Portfolio_by_maturity ?? []) allocations.push({ kind: 'maturity', label: m.Year, weight: numOrNull(m.Value) })

  const aumTotal = [aumEquity, aumDebt, aumMmi].reduce<number | null>((a, v) => (v == null ? a : (a ?? 0) + v), null)
  const ytm = pct(p.YTM_And_Modified_Duration?.find((x) => /ytm|yield/i.test(x.name))?.value)
  const md = numOrNull(p.YTM_And_Modified_Duration?.find((x) => /duration/i.test(x.name))?.value)

  const isGroup = /^ULGF/i.test(row.SFIN)
  const isPension = /pension/i.test(row.Fund)
  return {
    sfin: row.SFIN, // normalized inside store()
    name: row.Fund,
    class: isGroup ? 'Group' : isPension ? 'Pension' : 'Individual',
    category: row.AssetClass || null,
    nav: numOrNull(row.NAVLatest),
    inception: row.InceptionDate || null,
    benchmark: null,
    manager: null,
    ytm,
    modifiedDuration: md,
    aum: { equity: aumEquity, debt: aumDebt, mmi: aumMmi, total: aumTotal },
    returns,
    allocations,
    holdings,
  }
}

/** Fetch + store the latest ICICI disclosure. `monthOverride` forces the label. */
export async function ingestIciciWeb(opts: { monthOverride?: string; delayMs?: number } = {}): Promise<{ month: string; stored: number; withHoldings: number }> {
  // ICICI's edge WAF 403s plain server requests, so fetch the JSON from inside a real
  // Chromium session (which solves the challenge). Needs ULIP_CHROMIUM=1 + a driver.
  const session = await openApiSession(LANDING, { timeoutMs: 60_000 })
  if (!session) throw new Error('ICICI needs headless Chromium (set ULIP_CHROMIUM=1 + install puppeteer); WAF blocks plain fetch')

  try {
    const today = new Date()
    const end = `${String(today.getUTCDate()).padStart(2, '0')}-${today.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()}-${String(today.getUTCFullYear()).slice(-2)}`
    console.log('[icici-web] fetching fund list…')
    const list = await getJson<AllProductRow[]>(session, `${BASE}/funds-all-products.htm?startDate=${end}&endDate=${end}`)
    if (!Array.isArray(list) || list.length === 0) throw new Error('empty fund list')

    // AUDIT FIX (2026-07-14): derive the month from a CONSENSUS across the list, not just
    // list[0] (whose missing/garbled crteDate would silently mislabel all ~100 funds and
    // lock them under the wrong month). A plausibility check rejects future months too.
    const month = opts.monthOverride ?? consensusMonth(list)
    if (!month) throw new Error('could not determine disclosure month from fund list crteDates — pass monthOverride')
    const nowMonth = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`
    if (!opts.monthOverride && month > nowMonth) throw new Error(`derived month ${month} is in the future — refusing to store (pass monthOverride to force)`)
    console.log(`[icici-web] ${list.length} funds; labelling month ${month} (consensus of crteDates)`)

    const funds: ExtractedFund[] = []
    const codeBySfin = new Map<string, string>()
    let done = 0
    for (const row of list) {
      try {
        const p = await getJson<PortfolioResp>(session, `${BASE}/funds-portfolio-details.htm?fundCode=${encodeURIComponent(row.LAfundCode)}`)
        funds.push(toExtractedFund(row, p))
      } catch (e) {
        console.warn(`[icici-web] ${row.LAfundCode} (${row.Fund}) portfolio failed: ${(e as Error).message}`)
        funds.push(toExtractedFund(row, {})) // still store header/returns
      }
      codeBySfin.set(normalizeSfin(row.SFIN), row.LAfundCode)
      if (++done % 25 === 0) console.log(`[icici-web] portfolios ${done}/${list.length}`)
      await sleep(opts.delayMs ?? 120)
    }

    const res = await store(icicipru, month, funds)
    const withHoldings = funds.filter((f) => f.holdings.length > 0).length
    console.log(`[icici-web] stored ${res.stored} funds (${withHoldings} with holdings) for ${month}`)

    // Point each fund's source-link at its LIVE portfolio page (ICICI has no PDF), so the
    // "source factsheet" link opens the exact fund's portfolio details.
    const nowIso = new Date().toISOString()
    for (const [sfin, code] of codeBySfin) {
      const kind = `fund:${code}`
      const url = `${SITE}/funds-portfolio-details.html?fundCode=${encodeURIComponent(code)}`
      await sourcesRepo.upsert({ insurer: INSURER, month, kind, rawPath: '', url, sha256: '', fetchedAt: nowIso, parseStatus: 'web' })
      await db.update(fundsTable).set({ sourceKind: kind, sourcePage: null }).where(and(eq(fundsTable.sfin, sfin), eq(fundsTable.month, month)))
    }
    console.log('[icici-web] source links pointed at live portfolio pages')
    return { month, stored: res.stored, withHoldings }
  } finally {
    await session.close()
  }
}

// CLI: `tsx src/ulip/icici-web.ts [YYYY-MM]`
if (process.argv[1]?.endsWith('icici-web.ts')) {
  import('../load-env').then(async () => {
    const { pool } = await import('../db/client')
    await ingestIciciWeb({ monthOverride: process.argv[2] })
    await pool.end()
  })
}
