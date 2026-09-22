// Track record: how have the desk's own past calls actually done? Joins each stored
// signal snapshot to the symbol's FORWARD price and measures the realized return at a
// few horizons, then aggregates by tier. This is the feedback loop — it turns the
// scorer into something measurable (and, with calibration, tunable). Deterministic, no LLM.
import * as snapshotsRepo from '../repositories/guidanceSnapshots'
import * as histRepo from '../repositories/guidancePriceHistory'

const HORIZONS = [5, 20, 60] as const // trading days forward
const TIER_ORDER = ['high-conviction', 'constructive', 'neutral', 'avoid']

export interface TierStat {
  tier: string
  horizon: number
  n: number
  hitRate: number // % of calls with a positive forward return
  avgReturn: number // mean forward return %
  medianReturn: number
  worst: number
}
export interface TrackRecord {
  tiers: TierStat[]
  totalCalls: number
  evaluated: number // (snapshot × horizon) pairs with elapsed forward data
  since: string | null
  horizons: number[]
  note: string
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const r2 = (n: number) => Math.round(n * 100) / 100
/** Min of a possibly-huge array (Math.min(...xs) overflows the stack past ~100k args). */
const minOf = (xs: number[]) => xs.reduce((m, r) => (r < m ? r : m), Infinity)

export async function computeTrackRecord(): Promise<TrackRecord> {
  const snaps = await snapshotsRepo.all()
  const bySymbol = new Map<string, typeof snaps>()
  for (const s of snaps) {
    const a = bySymbol.get(s.symbol) ?? []
    a.push(s)
    bySymbol.set(s.symbol, a)
  }

  const acc = new Map<string, number[]>() // key `${tier}|${horizon}` -> forward returns
  let evaluated = 0
  for (const [sym, list] of bySymbol) {
    const closes = await histRepo.closesAsc(sym) // ascending {date, close}
    if (closes.length === 0) continue
    const idxByDate = new Map(closes.map((c, i) => [c.date, i]))
    for (const snap of list) {
      if (!snap.dataDate || !snap.tier) continue
      const i = idxByDate.get(snap.dataDate)
      if (i == null) continue
      const base = closes[i].close
      if (!base) continue
      for (const h of HORIZONS) {
        const j = i + h
        if (j >= closes.length) continue // horizon hasn't elapsed yet
        const ret = ((closes[j].close - base) / base) * 100
        const key = `${snap.tier}|${h}`
        const arr = acc.get(key) ?? []
        arr.push(ret)
        acc.set(key, arr)
        evaluated++
      }
    }
  }

  const tiers: TierStat[] = []
  for (const [key, rets] of acc) {
    const [tier, hs] = key.split('|')
    const horizon = Number(hs)
    tiers.push({
      tier,
      horizon,
      n: rets.length,
      hitRate: r2((rets.filter((r) => r > 0).length / rets.length) * 100),
      avgReturn: r2(rets.reduce((a, b) => a + b, 0) / rets.length),
      medianReturn: r2(median(rets)),
      worst: r2(minOf(rets)),
    })
  }
  tiers.sort((a, b) => (TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)) || a.horizon - b.horizon)

  return {
    tiers,
    totalCalls: snaps.length,
    evaluated,
    since: snaps.length ? snaps[snaps.length - 1].asOf : null,
    horizons: [...HORIZONS],
    note: 'Realized forward returns of each verdict tier, measured on the desk’s own past calls. Accumulates daily — the 20d/60d columns need ~1–3 months of history to be meaningful.',
  }
}
