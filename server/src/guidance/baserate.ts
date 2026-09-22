// Historical base rate — the measured, self-doubting core of the desk.
//
// For the CURRENT setup (a single-day drop of a given severity band), we scan our own
// deep price history for COMPARABLE past setups and report what actually happened next:
// the distribution of forward returns from the dip, how often price returned to its
// pre-drop level, and — shown explicitly — the misses and the worst case. No forward
// outcome is asserted; if the sample is thin we say so (lowConfidence) rather than
// inventing a percentage.
//
// Definitions (documented; see GUIDANCE.md):
//  • "comparable setup" = a trading day whose single-session drop falls in the same
//    severity band as today's trigger (e.g. 5–8%). Optionally pooled across a cohort of
//    curated peers to grow the sample.
//  • "recovered (touched)"  = within the horizon, price traded back up to or above the
//    close BEFORE the drop (the pre-drop level).
//  • "recovered (terminal)" = the close AT horizon h was ≥ the pre-drop level.
//  • forward returns are measured from the DIP close (what a dip-buyer would earn).
//  • Overlapping setups within `maxHorizon` of a prior counted one (same symbol) are
//    skipped, so samples stay quasi-independent rather than double-counting one episode.
import type { Close } from './factors'

export interface HorizonStat {
  horizon: number
  n: number
  mean: number // average forward return % — the expectancy input (#5); median is the display headline
  median: number
  p25: number
  p75: number
  worst: number
  best: number
  positivePct: number // share of instances with forward return > 0
  recoveredTerminalPct: number // close at h ≥ pre-drop level (down) / ≥ pre-pop base (up)
  lowConfidence: boolean // M-G2: THIS horizon's n is below the min-sample threshold
}

export interface BaseRate {
  setup: string
  direction: 'down' | 'up' // 'down' = dip-buy after a fall; 'up' = momentum after a one-day pop
  band: [number, number]
  cohortLabel: string
  symbols: string[]
  // 9.6: regime conditioning — a -6% day in a crash is not comparable to one in a quiet
  // bull tape. When the index state on the setup date is known, the sample is restricted
  // to instances that occurred in TODAY's market state (NIFTY above/below its 200-DMA).
  regimeState: 'above' | 'below' | null // today's index state the sample was matched to (null = unconditioned)
  regimeConditioned: boolean // false = matched sample was too thin; fell back to all-regimes
  // 9.5: point-in-time universe — when index-membership history is available, the sample
  // is restricted to instances whose symbol was actually IN the index on the setup date
  // (and to dates the membership ledger covers), killing survivorship bias over that span.
  // null = no membership data; conditioned=false = data exists but the filtered sample was
  // too thin (or fully pre-coverage), so the survivor-conditioned sample is shown instead.
  pitCoverage: { from: string; conditioned: boolean } | null
  // #3: how comparables were matched. 'knn' = the k past setups most similar to TODAY's
  // (move size + RSI + drawdown, z-normalized); 'band' = classic same-severity-band match
  // (the fallback when the pool is too thin or today's features are unavailable).
  matching: 'knn' | 'band'
  k: number | null // knn only: how many nearest setups were kept
  n: number
  horizons: HorizonStat[]
  recoveredTouchPct: number | null // touched pre-drop level within max horizon
  worstCase: { forwardReturn: number; horizon: number; date: string; symbol: string } | null
  misses: { forwardReturn: number; date: string; symbol: string }[] // instances that stayed underwater at max horizon
  lowConfidence: boolean
  activeSetup: boolean // M-G1: false on a quiet day (move outside every band) — no dip/pop base rate applies
  note: string
}

interface Instance {
  symbol: string
  date: string
  entryClose: number
  preDropClose: number
  forward: Map<number, number> // horizon → forward return % from entry
  touched: boolean // reached pre-drop level within maxHorizon
  terminalAbovePre: Map<number, boolean>
  idxState: 'above' | 'below' | null // NIFTY vs its 200-DMA on the setup date (null = index history unavailable there)
  // #3 (nearest-neighbour matching): what the setup LOOKED like on its day, so today's
  // setup can be compared to past days that resembled it — not just any day in the band.
  feat: SetupFeatures
}

/** The features that make two setup days "comparable": the size of the move, how
 *  oversold/overbought the name already was, and how far it sat below its 1-year high. */
export interface SetupFeatures {
  movePct: number
  rsi14: number | null
  ddFromHighPct: number | null // % below the rolling 252-session high (≤ 0)
}

/** Rolling simple 14-day RSI per index (null until enough history). */
function rsiSeries(c: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null)
  for (let i = n; i < c.length; i++) {
    let g = 0
    let l = 0
    for (let j = i - n + 1; j <= i; j++) {
      const d = c[j] - c[j - 1]
      if (d >= 0) g += d
      else l -= d
    }
    out[i] = g + l === 0 ? 50 : 100 - 100 / (1 + g / (l || 1e-9))
  }
  return out
}

/** Rolling drawdown (%) from the trailing 252-session high, per index. */
function ddSeries(c: number[], window = 252): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null)
  for (let i = 0; i < c.length; i++) {
    const from = Math.max(0, i - window + 1)
    let hi = -Infinity
    for (let j = from; j <= i; j++) if (c[j] > hi) hi = c[j]
    if (hi > 0 && i - from >= 20) out[i] = ((c[i] - hi) / hi) * 100
  }
  return out
}

/**
 * 9.6: per-date index state (close vs rolling 200-DMA) from the NIFTY deep history.
 * Returned as a sorted date array + state array so instance dates that fall on a
 * stock-only trading day can be matched to the most recent index session at/before them.
 */
export interface IndexStates {
  dates: string[]
  states: ('above' | 'below')[]
}
export function indexStateSeries(indexCloses: Close[]): IndexStates | null {
  if (indexCloses.length < 210) return null
  const dates: string[] = []
  const states: ('above' | 'below')[] = []
  let sum = 0
  for (let i = 0; i < indexCloses.length; i++) {
    sum += indexCloses[i].close
    if (i >= 200) sum -= indexCloses[i - 200].close
    if (i >= 199) {
      dates.push(indexCloses[i].date)
      states.push(indexCloses[i].close >= sum / 200 ? 'above' : 'below')
    }
  }
  return { dates, states }
}

/** Index state at/most-recently-before `date` (binary search — series are long). */
function stateOn(idx: IndexStates, date: string): 'above' | 'below' | null {
  let lo = 0
  let hi = idx.dates.length - 1
  if (hi < 0 || date < idx.dates[0]) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (idx.dates[mid] <= date) lo = mid
    else hi = mid - 1
  }
  return idx.states[lo]
}

function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * Find comparable setups in one symbol's series and measure their forward outcomes.
 *  • direction 'down' (dip-buy): the day's single-session DROP falls in the band. Entry is
 *    the post-drop close; "recovered" = price returns to the pre-drop close (a higher bar).
 *  • direction 'up' (momentum): the day's single-session RISE falls in the band. Entry is
 *    the post-pop close; "held" = price is still ≥ the popped entry at the horizon, and
 *    "touched" is reframed as fading all the way back to the pre-pop base.
 * Forward returns are always measured from the entry close (what a buyer that day earns).
 */
function setupsForSeries(symbol: string, closes: Close[], band: [number, number], horizons: number[], direction: 'down' | 'up', idx: IndexStates | null = null): Instance[] {
  const c = closes.map((x) => x.close)
  const maxH = Math.max(...horizons)
  const rsis = rsiSeries(c)
  const dds = ddSeries(c)
  const out: Instance[] = []
  let lastCounted = -Infinity
  for (let i = 1; i < c.length; i++) {
    const move = ((c[i] - c[i - 1]) / c[i - 1]) * 100
    const inBand = direction === 'down' ? move <= -band[0] && move > -band[1] : move >= band[0] && move < band[1]
    if (!inBand) continue
    if (i - lastCounted < maxH) continue // keep samples quasi-independent
    const entry = c[i]
    const ref = c[i - 1] // pre-move close (pre-drop for dips, pre-pop base for risers)
    const forward = new Map<number, number>()
    const terminalAbovePre = new Map<number, boolean>()
    let touched = false
    for (const h of horizons) {
      if (i + h < c.length) {
        forward.set(h, ((c[i + h] - entry) / entry) * 100)
        // Both directions measure "closed at/above the pre-MOVE reference" (`ref` = the
        // close before the move). down: back to the pre-drop level (full recovery). up:
        // STILL above the pre-pop base (M-G4: distinct from positivePct, which is
        // measured vs the popped ENTRY — otherwise the two headline stats duplicated).
        terminalAbovePre.set(h, c[i + h] >= ref)
      }
    }
    // down: reached the pre-drop level (recovered). up: faded back to the pre-pop base.
    for (let j = i + 1; j <= Math.min(i + maxH, c.length - 1); j++) {
      if (direction === 'down' ? c[j] >= ref : c[j] <= ref) { touched = true; break }
    }
    // Only count setups with at least the shortest horizon of forward room.
    if (forward.size > 0) {
      out.push({
        symbol,
        date: closes[i].date,
        entryClose: entry,
        preDropClose: ref,
        forward,
        touched,
        terminalAbovePre,
        idxState: idx ? stateOn(idx, closes[i].date) : null,
        feat: { movePct: round2(move), rsi14: rsis[i], ddFromHighPct: dds[i] == null ? null : round2(dds[i]!) },
      })
      lastCounted = i
    }
  }
  return out
}

/**
 * #3: pick the k past setups that most RESEMBLED today's, by z-normalized distance over
 * (move size, RSI, drawdown-from-high). Any −5% day is not comparable to any other −5%
 * day — a fresh crack in an uptrend and the 40th leg of a collapse have very different
 * forward odds. Only dimensions today actually has (and the instance has) participate,
 * so partial features degrade gracefully rather than biasing the distance.
 */
function nearestSetups(pool: Instance[], today: SetupFeatures, k: number): Instance[] {
  const dims: { get: (f: SetupFeatures) => number | null; today: number | null }[] = [
    { get: (f) => f.movePct, today: today.movePct },
    { get: (f) => f.rsi14, today: today.rsi14 },
    { get: (f) => f.ddFromHighPct, today: today.ddFromHighPct },
  ]
  // Per-dimension std over the pool (guard degenerate spreads with a floor).
  const stds = dims.map((d) => {
    const xs = pool.map((x) => d.get(x.feat)).filter((v): v is number => v != null)
    if (xs.length < 5) return null
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const varr = xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length
    return Math.max(Math.sqrt(varr), 1e-6)
  })
  const scored = pool.map((inst) => {
    let dist = 0
    let used = 0
    for (let d = 0; d < dims.length; d++) {
      const t = dims[d].today
      const v = dims[d].get(inst.feat)
      const s = stds[d]
      if (t == null || v == null || s == null) continue
      dist += ((v - t) / s) ** 2
      used++
    }
    // An instance sharing no usable dimensions can't be ranked — push it to the back.
    return { inst, dist: used ? dist / used : Infinity }
  })
  scored.sort((a, b) => a.dist - b.dist)
  return scored.slice(0, k).map((s) => s.inst)
}

function aggregate(instances: Instance[], horizons: number[], minSamples: number): Omit<BaseRate, 'setup' | 'direction' | 'band' | 'cohortLabel' | 'symbols' | 'activeSetup' | 'note' | 'regimeState' | 'regimeConditioned' | 'pitCoverage' | 'matching' | 'k'> {
  const horizonStats: HorizonStat[] = horizons.map((h) => {
    const rets = instances.map((x) => x.forward.get(h)).filter((x): x is number => x != null)
    const sorted = [...rets].sort((a, b) => a - b)
    const terminal = instances.map((x) => x.terminalAbovePre.get(h)).filter((x): x is boolean => x != null)
    return {
      horizon: h,
      n: rets.length,
      mean: rets.length ? round2(rets.reduce((a, b) => a + b, 0) / rets.length) : 0,
      median: round2(pctile(sorted, 50)),
      p25: round2(pctile(sorted, 25)),
      p75: round2(pctile(sorted, 75)),
      worst: round2(sorted[0] ?? 0),
      best: round2(sorted[sorted.length - 1] ?? 0),
      positivePct: rets.length ? Math.round((rets.filter((r) => r > 0).length / rets.length) * 100) : 0,
      recoveredTerminalPct: terminal.length ? Math.round((terminal.filter(Boolean).length / terminal.length) * 100) : 0,
      // M-G2: flag confidence PER horizon — the longest horizons lose samples fast (fewer
      // bars have `maxHorizon` of forward room), so a 60-day cell can be thin even when the
      // 10-day cell is well-populated. `recoveredMinSamples` is threaded from config.
      lowConfidence: rets.length < minSamples,
    }
  })
  const touchN = instances.length
  const recoveredTouchPct = touchN ? Math.round((instances.filter((x) => x.touched).length / touchN) * 100) : null
  // Worst single outcome at the longest available horizon (shown explicitly).
  let worstCase: BaseRate['worstCase'] = null
  const misses: BaseRate['misses'] = []
  for (const x of instances) {
    const h = [...horizons].reverse().find((hh) => x.forward.has(hh))
    if (h == null) continue
    const ret = x.forward.get(h)!
    if (!worstCase || ret < worstCase.forwardReturn) worstCase = { forwardReturn: round2(ret), horizon: h, date: x.date, symbol: x.symbol }
    if (ret < 0) misses.push({ forwardReturn: round2(ret), date: x.date, symbol: x.symbol })
  }
  misses.sort((a, b) => a.forwardReturn - b.forwardReturn)
  return { n: instances.length, horizons: horizonStats, recoveredTouchPct, worstCase, misses: misses.slice(0, 8), lowConfidence: instances.length < minSamples }
}

export interface BaseRateInput {
  symbol: string
  selfCloses: Close[]
  cohort: { symbol: string; closes: Close[] }[] // peers (may be empty)
  cohortLabel: string
  band: [number, number] | null // M-G1: null on a quiet day (move outside every band) → no active setup
  horizons: number[]
  direction?: 'down' | 'up' // default 'down' (dip-buy); 'up' = momentum after a one-day pop
  minSamples?: number // M-G2: n below which a base rate / horizon is flagged lowConfidence
  // #3: today's setup features + the full band ladder — enables nearest-neighbour
  // matching over a wide pool (any active-direction move ≥ the mildest band edge).
  features?: SetupFeatures
  allBands?: [number, number][]
  indexCloses?: Close[] // 9.6: NIFTY deep history — enables regime-conditioned matching
  // 9.5: point-in-time membership lookup (built once per signal from the index_membership
  // ledger). When present, instances are only counted if the symbol was in the index on
  // the setup date and the date falls inside ledger coverage.
  membership?: { wasMember(symbol: string, date: string): boolean; coverageStart: string | null }
}

/** An empty base rate used when there is no active setup (a quiet day) or no band. */
function emptyBaseRate(symbol: string, direction: 'down' | 'up', horizons: number[], minSamples: number, note: string): BaseRate {
  return {
    setup: 'no active setup',
    direction,
    band: [0, 0],
    cohortLabel: `${symbol} only`,
    symbols: [symbol],
    regimeState: null,
    regimeConditioned: false,
    pitCoverage: null,
    matching: 'band',
    k: null,
    activeSetup: false,
    note,
    ...aggregate([], horizons, minSamples),
  }
}

/**
 * 9.5: restrict a sample to instances that were actually IN the index (point-in-time) on
 * their setup date, over the span the membership ledger covers. Mirrors the regime
 * fallback philosophy: when the filtered sample is too thin to be meaningful, keep the
 * full survivor-conditioned sample and mark conditioned=false so the caveat stays honest.
 */
function conditionOnMembership(
  instances: Instance[],
  membership: BaseRateInput['membership'],
  minSamples: number,
): { instances: Instance[]; pit: BaseRate['pitCoverage'] } {
  if (!membership || !membership.coverageStart) return { instances, pit: null }
  const from = membership.coverageStart
  const matched = instances.filter((x) => x.date >= from && membership.wasMember(x.symbol, x.date))
  if (matched.length >= minSamples) return { instances: matched, pit: { from, conditioned: true } }
  return { instances, pit: { from, conditioned: false } }
}

const pitNote = (pit: BaseRate['pitCoverage']): string => {
  if (!pit) return ''
  return pit.conditioned
    ? ` Point-in-time universe applied from ${pit.from}: only instances whose symbol was in the index on the setup date are counted.`
    : ` Membership history (from ${pit.from}) left too few point-in-time instances — showing the survivor-conditioned sample instead.`
}

/**
 * 9.6: restrict a sample to instances that occurred in today's market state. Falls back
 * to the full (all-regimes) sample when the matched subset is too thin to be meaningful —
 * a conditioned n of 3 would be worse than an honest unconditioned n of 40.
 */
function conditionOnRegime(
  instances: Instance[],
  todayState: 'above' | 'below' | null,
  minSamples: number,
): { instances: Instance[]; conditioned: boolean } {
  if (!todayState) return { instances, conditioned: false }
  const matched = instances.filter((x) => x.idxState === todayState)
  if (matched.length >= minSamples) return { instances: matched, conditioned: true }
  return { instances, conditioned: false }
}

const regimeNote = (conditioned: boolean, todayState: 'above' | 'below' | null): string => {
  if (!todayState) return ''
  const state = `NIFTY ${todayState} its 200-DMA`
  return conditioned
    ? ` Sample restricted to comparable setups that occurred in today's market state (${state}).`
    : ` Too few comparable setups in today's market state (${state}) — showing all-regimes odds instead.`
}

/** Build both a stock-only and a cohort-pooled base rate for the current setup band. */
export function computeBaseRate(input: BaseRateInput): { self: BaseRate; cohort: BaseRate | null } {
  const { symbol, selfCloses, cohort, cohortLabel, band, horizons } = input
  const direction = input.direction ?? 'down'
  const minSamples = input.minSamples ?? 10

  // M-G1: today's move is inside the normal daily range (outside every drop/rise band) —
  // there is no dip/pop to base-rate. Returning the mildest band here is what mislabelled a
  // +2% day as a "3–5% drop" dip-buy. Say "no active setup" instead of inventing one.
  if (!band) {
    return {
      self: emptyBaseRate(symbol, direction, horizons, minSamples, 'No active setup: today’s move is within the normal daily range — no dip/pop base rate applies.'),
      cohort: null,
    }
  }

  const verb = direction === 'down' ? 'drop' : 'rise'

  // 9.6: index-state series + today's state. `stateOn` of the LAST index date = today's
  // regime side; each instance is matched to the state on ITS setup date.
  const idx = input.indexCloses ? indexStateSeries(input.indexCloses) : null
  const todayState = idx ? idx.states[idx.states.length - 1] : null

  // #3: when today's features + the band ladder are supplied, collect a WIDE pool (any
  // active-direction move ≥ the mildest band edge) and let nearest-neighbour matching pick
  // the k most-similar past days. The knn pool needs enough depth AFTER the pit/regime
  // filters to be meaningful; otherwise fall back to the classic same-band match.
  const mildest = input.allBands?.length ? Math.min(...input.allBands.map((b) => b[0])) : null
  const knnEligible = input.features != null && mildest != null
  const poolBand: [number, number] | null = knnEligible ? [mildest!, 1e9] : null
  const knnK = Math.min(40, Math.max(20, minSamples * 2))
  const knnMinPool = knnK // fewer matched-state instances than k → knn adds nothing over the band

  /** Shared per-sample pipeline: collect → PIT → regime → (knn | band) → aggregate. */
  const build = (
    series: { symbol: string; closes: Close[] }[],
    label: string,
    baseNote: string,
  ): BaseRate => {
    const collect = (b: [number, number]) => series.flatMap((p) => setupsForSeries(p.symbol, p.closes, b, horizons, direction, idx))
    let matching: BaseRate['matching'] = 'band'
    let k: number | null = null

    let all = collect(poolBand ?? band)
    let pit = conditionOnMembership(all, input.membership, minSamples)
    let cond = conditionOnRegime(pit.instances, todayState, minSamples)
    let instances = cond.instances

    if (knnEligible && instances.length >= knnMinPool) {
      instances = nearestSetups(instances, input.features!, knnK)
      matching = 'knn'
      k = instances.length
    } else if (knnEligible) {
      // Pool too thin for knn — recollect with the classic band filter so the fallback
      // matches the pre-#3 behaviour exactly (band spacing, band-only instances).
      all = collect(band)
      pit = conditionOnMembership(all, input.membership, minSamples)
      cond = conditionOnRegime(pit.instances, todayState, minSamples)
      instances = cond.instances
    }

    const setupLabel =
      matching === 'knn'
        ? `single-day ${verb} like today's (${input.features!.movePct >= 0 ? '+' : ''}${input.features!.movePct}%${input.features!.rsi14 != null ? `, RSI ${Math.round(input.features!.rsi14)}` : ''}${input.features!.ddFromHighPct != null ? `, ${Math.abs(Math.round(input.features!.ddFromHighPct))}% off the 1y high` : ''})`
        : `single-day ${verb} of ${band[0]}–${band[1] >= 100 ? '∞' : band[1]}%`
    const matchNote =
      matching === 'knn'
        ? ` Comparables are the ${k} past setups most similar to today's (matched on move size, RSI and drawdown), not just any ${verb} in the band.`
        : ''

    return {
      setup: setupLabel,
      direction,
      band,
      cohortLabel: label,
      symbols: series.map((p) => p.symbol),
      regimeState: todayState,
      regimeConditioned: cond.conditioned,
      pitCoverage: pit.pit,
      matching,
      k,
      activeSetup: true,
      note: baseNote + pitNote(pit.pit) + regimeNote(cond.conditioned, todayState) + matchNote,
      ...aggregate(instances, horizons, minSamples),
    }
  }

  const self = build(
    [{ symbol, closes: selfCloses }],
    `${symbol} only`,
    selfCloses.length < 250 ? 'Shallow history — base rate computed on a short window; treat as indicative only.' : '',
  )

  let cohortRate: BaseRate | null = null
  if (cohort.length >= 1) {
    cohortRate = build(
      [{ symbol, closes: selfCloses }, ...cohort],
      cohortLabel,
      'Pooled across the curated peer cohort to grow the sample — cohort behaviour can differ from the single name.',
    )
  }
  return { self, cohort: cohortRate }
}

/** Which severity band a given move% falls into (for choosing the comparable setup), or
 *  null when |move| is inside the normal daily range (below the mildest band) — M-G1:
 *  no active setup, so no base rate should be fabricated. */
export function bandForDrop(dropPct: number, bands: [number, number][]): [number, number] | null {
  const d = Math.abs(dropPct)
  for (const b of bands) if (d >= b[0] && d < b[1]) return b
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
