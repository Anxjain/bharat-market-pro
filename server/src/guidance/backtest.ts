// Setup calibration (backtest): the empirical, universe-wide validation of the timing
// axis. For every symbol with deep history, at every bar, we band the 1-day move (dip or
// pop) and record the FORWARD return at several horizons. Pooling across all names and
// all history gives large, well-sampled odds with confidence intervals — the honest
// answer to "after a move like this, what usually happens?", and the substrate for
// calibrating the score. Deterministic (price-only, no LLM). Cached (recompute ~daily).
// 9.5: when index-membership history is available, the pooled cohort is point-in-time —
// a bar only contributes if its symbol was actually in the NIFTY 500 on that date (and the
// date falls inside ledger coverage), so calibration stops crediting survivors with the
// full depth of their pre-index history.
import * as histRepo from '../repositories/guidancePriceHistory'
import * as membershipRepo from '../repositories/indexMembership'

const HORIZONS = [5, 20, 60] as const
// Bands are [loInclusive, hiExclusive) in percent 1-day move; dips negative, pops positive.
const BANDS: { key: string; dir: 'dip' | 'pop'; lo: number; hi: number }[] = [
  { key: 'dip 3–5%', dir: 'dip', lo: -5, hi: -3 },
  { key: 'dip 5–8%', dir: 'dip', lo: -8, hi: -5 },
  { key: 'dip 8–15%', dir: 'dip', lo: -15, hi: -8 },
  { key: 'dip >15%', dir: 'dip', lo: -100, hi: -15 },
  { key: 'pop 3–5%', dir: 'pop', lo: 3, hi: 5 },
  { key: 'pop 5–8%', dir: 'pop', lo: 5, hi: 8 },
  { key: 'pop >8%', dir: 'pop', lo: 8, hi: 100 },
]

export interface BandCalib {
  band: string
  dir: 'dip' | 'pop'
  horizon: number
  n: number
  positivePct: number
  ciLow: number
  ciHigh: number
  median: number
  avg: number
  worst: number
}
export interface SetupCalibration {
  bands: BandCalib[]
  symbols: number
  instances: number
  computedAt: string
  note: string
  // 9.5: null = no membership ledger; conditioned=true = the cohort was restricted to
  // point-in-time index members over the covered span.
  pitCoverage?: { from: string; conditioned: boolean } | null
}

/** Wilson score interval for a binomial proportion (better than normal approx at small n). */
function wilson(pos: number, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const z = 1.96
  const p = pos / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)]
}
function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const r2 = (n: number) => Math.round(n * 100) / 100

let cache: { at: number; data: SetupCalibration } | null = null
const TTL_MS = 24 * 60 * 60 * 1000

export async function computeSetupCalibration(force = false): Promise<SetupCalibration> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data

  const symbols = await histRepo.symbolsWithData()
  // 9.5: point-in-time membership (optional — an empty ledger leaves behavior unchanged).
  const membership = await membershipRepo.cachedChecker().catch(() => null)
  const pitFrom = membership?.coverageStart ?? null
  // accumulate forward returns per (bandKey|horizon)
  const acc = new Map<string, number[]>()
  let instances = 0
  for (const sym of symbols) {
    const closes = await histRepo.closesAsc(sym)
    if (closes.length < 70) continue
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1].close
      if (!prev) continue
      // 9.5: skip bars outside membership coverage or where the symbol wasn't in the index.
      if (pitFrom && (closes[i].date < pitFrom || !membership!.wasMember(sym, closes[i].date))) continue
      const move = ((closes[i].close - prev) / prev) * 100
      const band = BANDS.find((b) => move >= b.lo && move < b.hi)
      if (!band) continue
      const base = closes[i].close
      for (const h of HORIZONS) {
        const j = i + h
        if (j >= closes.length) break
        const ret = ((closes[j].close - base) / base) * 100
        const key = `${band.key}|${h}`
        const arr = acc.get(key) ?? []
        arr.push(ret)
        acc.set(key, arr)
        instances++
      }
    }
  }

  const bands: BandCalib[] = []
  for (const b of BANDS) {
    for (const h of HORIZONS) {
      const rets = acc.get(`${b.key}|${h}`)
      if (!rets || rets.length === 0) continue
      const pos = rets.filter((r) => r > 0).length
      const [lo, hi] = wilson(pos, rets.length)
      bands.push({
        band: b.key,
        dir: b.dir,
        horizon: h,
        n: rets.length,
        positivePct: r2((pos / rets.length) * 100),
        ciLow: r2(lo * 100),
        ciHigh: r2(hi * 100),
        median: r2(median(rets)),
        avg: r2(rets.reduce((a, c) => a + c, 0) / rets.length),
        worst: r2(Math.min(...rets)),
      })
    }
  }

  const data: SetupCalibration = {
    bands,
    symbols: symbols.length,
    instances,
    computedAt: new Date().toISOString(),
    note:
      'Universe-wide empirical outcomes after each 1-day move band, pooled across all names' +
      (pitFrom
        ? ` and restricted to the point-in-time NIFTY 500 (membership ledger coverage from ${pitFrom})`
        : ' and all deep history') +
      ', with 95% Wilson confidence intervals. This is the calibrated base-rate the per-name odds should be read against.',
    pitCoverage: pitFrom ? { from: pitFrom, conditioned: true } : null,
  }
  cache = { at: Date.now(), data }
  return data
}
