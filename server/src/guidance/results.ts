// Quarterly/annual results reader for the guidance desk. Scrapes screener.in's
// quarterly table (Sales, Net Profit per quarter) and turns it into an earnings TREND
// — TTM growth, latest-quarter YoY, and an improving/deteriorating read — so the verdict
// reflects whether the BUSINESS is getting better, not just the price. Persisted to the
// DB (guidance_results) so it accumulates and is re-scraped at most every few days.
import * as resultsRepo from '../repositories/guidanceResults'

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }

export interface QuarterPoint {
  q: string
  sales: number | null
  profit: number | null
}
export interface ResultsTrend {
  asOfQuarter: string | null
  salesLatestYoY: number | null
  profitLatestYoY: number | null
  salesTtmGrowth: number | null
  profitTtmGrowth: number | null
  direction: 'improving' | 'deteriorating' | 'mixed' | null
  quarters: QuarterPoint[]
  source: 'screener.in'
  note: string
}

const cache = new Map<string, { data: ResultsTrend | null; at: number }>()
const TTL = 6 * 60 * 60 * 1000

function nums(cell: string): number | null {
  const m = cell.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
function rowFor(block: string, label: RegExp): number[] | null {
  for (const tr of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    if (cells.length && label.test(cells[0])) return cells.slice(1).map((c) => nums(c) ?? NaN)
  }
  return null
}
// NaN guard: a blank/misparsed quarter (NaN) must yield null, never a NaN that renders as
// "+NaN%" in the UI. (L: NaN leaks.)
const yoy = (s: number[], i: number) =>
  i >= 4 && Number.isFinite(s[i]) && Number.isFinite(s[i - 4]) && s[i - 4] !== 0 ? ((s[i] - s[i - 4]) / Math.abs(s[i - 4])) * 100 : null
const sum = (a: number[]) => a.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0)

async function fetchResults(symbol: string): Promise<ResultsTrend | null> {
  for (const url of [`https://www.screener.in/company/${symbol}/consolidated/`, `https://www.screener.in/company/${symbol}/`]) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      // M-G8: back off on rate-limiting rather than hammering screener.
      if (res.status === 429 || res.status === 503) {
        console.warn(`[guidance:results] ${symbol}: HTTP ${res.status} (rate-limited) — backing off`)
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      if (!res.ok) continue
      const html = await res.text()
      const sec = html.match(/<section id="quarters"[\s\S]*?<\/section>/)
      if (!sec) continue
      const block = sec[0]
      const heads = [...block.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
      const sales = rowFor(block, /^sales|^revenue|^total income/i)
      const profit = rowFor(block, /^net profit/i)
      if (!sales || !profit || sales.length < 5) continue
      const n = sales.length
      const quarters: QuarterPoint[] = heads.slice(-n).map((q, i) => ({ q, sales: Number.isFinite(sales[i]) ? sales[i] : null, profit: Number.isFinite(profit[i]) ? profit[i] : null }))
      const salesLatestYoY = round1(yoy(sales, n - 1))
      const profitLatestYoY = round1(yoy(profit, n - 1))
      const salesTtm = n >= 8 ? round1(((sum(sales.slice(-4)) - sum(sales.slice(-8, -4))) / Math.abs(sum(sales.slice(-8, -4)) || 1)) * 100) : null
      const profitTtm = n >= 8 ? round1(((sum(profit.slice(-4)) - sum(profit.slice(-8, -4))) / Math.abs(sum(profit.slice(-8, -4)) || 1)) * 100) : null
      const direction =
        profitTtm == null
          ? null
          : profitTtm > 8 && (salesTtm ?? 0) > 0
            ? 'improving'
            : profitTtm < -8
              ? 'deteriorating'
              : 'mixed'
      return {
        asOfQuarter: heads[heads.length - 1] ?? null,
        salesLatestYoY,
        profitLatestYoY,
        salesTtmGrowth: salesTtm,
        profitTtmGrowth: profitTtm,
        direction,
        quarters: quarters.slice(-6),
        source: 'screener.in',
        note: 'Quarterly results from screener.in (₹ Cr). TTM = last 4 quarters vs the prior 4.',
      }
    } catch {
      /* try next variant */
    }
  }
  return null
}

const REFRESH_MS = 3 * 24 * 60 * 60 * 1000 // re-scrape results at most every 3 days

export async function getResultsTrend(symbol: string): Promise<ResultsTrend | null> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.at < TTL) return hit.data

  // DB-first: results accumulate and survive restarts; only re-scrape when stale.
  const stored = await resultsRepo.get<ResultsTrend>(sym).catch(() => null)
  if (stored && Date.now() - Date.parse(stored.updatedAt) < REFRESH_MS) {
    cache.set(sym, { data: stored.json, at: Date.now() })
    return stored.json
  }

  const data = await fetchResults(sym)
  if (data) {
    await resultsRepo.set(sym, data).catch(() => {})
    cache.set(sym, { data, at: Date.now() })
    return data
  }
  // Scrape failed → fall back to the last good stored value (reliability over freshness).
  if (stored) {
    cache.set(sym, { data: stored.json, at: Date.now() })
    return stored.json
  }
  cache.set(sym, { data: null, at: Date.now() })
  return null
}

function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10
}
