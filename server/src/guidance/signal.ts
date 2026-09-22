// Signal compositor — assembles the factor stack + base rate into one auditable
// signal. The tier is a STANCE; it is always returned alongside the full factor
// breakdown and the measured base rate, and is capped down when a thesis-breaker
// (dilution, auditor/rating/legal flag, catastrophic drawdown history) fires.
import { deepCloses, deepCandles, ensureHistory, hasDeepHistory } from './history'
import { computeFactors, type Factor, type Close, type FactorGroup } from './factors'
import { computeBaseRate, bandForDrop, type BaseRate } from './baserate'
import { loadConfig, tierFor, type TierCut } from './config'
import { buildReadout, type Readout } from './readout'
import { getDevelopments, type Developments } from './developments'
import { getResultsTrend, type ResultsTrend } from './results'
import { getFundamentals, type Fundamentals } from './fundamentals'
import * as watchRepo from '../repositories/guidanceWatchlist'
import * as membershipRepo from '../repositories/indexMembership'
import * as guidanceFilingsRepo from '../repositories/guidanceFilings'
import * as snapshotsRepo from '../repositories/guidanceSnapshots'
import { getInstrument } from '../repositories/instruments'
import { getFactSheet, type FactSheet } from '../fact-sheet'
import { fetchLiveNews } from '../news-rss'
import { computeRegime, type Regime } from './regime'

export interface GroupSummary {
  group: FactorGroup
  score: number // weighted-average normalized score for the group
  weight: number
  factors: Factor[]
}

export interface Signal {
  symbol: string
  name: string | null
  asOf: string
  dataDate: string | null
  price: number | null
  score: number // 0–100 composite
  normalized: number // −1..+1
  tier: TierCut['tier']
  cappedByRisk: boolean
  breaks: string[] // labels of thesis-breakers that fired
  factors: Factor[]
  groups: GroupSummary[]
  baserate: { self: BaseRate; cohort: BaseRate | null }
  readout: Readout // plain-English verdict + reasons (leads the UI)
  developments: Developments // recent filings + news, classified
  results: ResultsTrend | null // quarterly earnings trend
  quality: Fundamentals | null // BUSINESS-QUALITY axis (separate from the timing/setup score)
  watch: watchRepo.WatchEntry | null
  deep: boolean
  note: string
  regime: Regime // market regime + the caution it applied to this signal
  expectancy: Expectancy | null // #5: odds → expected value per ₹100 + suggested size
}

/** #5: the base rate turned into a decision aid — what ₹100 in this setup has RETURNED
 *  on average across the matched comparables, at the best-expectancy horizon, plus an
 *  honest downside line and a position-size suggestion derived from both. */
export interface Expectancy {
  horizon: number // trading days
  evPer100: number // mean forward return of the comparables ≈ expected ₹ on ₹100
  winRate: number // % of comparables positive at that horizon
  typicalWin: number // p75 — what the better half of wins looked like
  typicalLoss: number // p25 — what the losses/laggards looked like
  worst: number // the single worst comparable (never hidden)
  n: number
  lowConfidence: boolean
  size: 'none' | 'small' | 'medium' | 'full'
  sizeNote: string
  source: 'self' | 'cohort'
}

const GROUP_ORDER: FactorGroup[] = ['price', 'relative', 'catalyst', 'news', 'fundamental', 'risk']

async function cohortFor(symbol: string, watch: watchRepo.WatchEntry | null, all: watchRepo.WatchEntry[]): Promise<{ symbol: string; closes: Close[]; tags: string[] }[]> {
  if (!watch || watch.tags.length === 0) return []
  const peers = all.filter((w) => w.symbol !== symbol && w.active && w.tags.some((t) => watch.tags.includes(t))).slice(0, 8)
  const out: { symbol: string; closes: Close[]; tags: string[] }[] = []
  for (const p of peers) {
    const closes = await deepCloses(p.symbol)
    if (closes.length > 20) out.push({ symbol: p.symbol, closes, tags: p.tags })
  }
  return out
}

/**
 * #5: expectancy — the matched comparables' MEAN forward return at the best-expectancy
 * horizon, i.e. "what ₹100 in this exact setup has returned on average". Sizing derives
 * from expectancy + confidence, and is zeroed whenever a thesis-breaker / fundamentals
 * force-avoid fired (an edge you shouldn't take isn't an edge).
 */
function computeExpectancy(
  baserate: { self: BaseRate; cohort: BaseRate | null },
  tier: TierCut['tier'],
  cappedByRisk: boolean,
  forceAvoid: boolean,
): Expectancy | null {
  const br = baserate.cohort && baserate.cohort.n >= baserate.self.n ? baserate.cohort : baserate.self
  if (!br || br.activeSetup === false || br.n === 0) return null
  const usable = br.horizons.filter((h) => h.n >= 5)
  if (usable.length === 0) return null
  // Best mean-return horizon; prefer the ~1-month cell on ties (it's the calibrated one).
  const best = [...usable].sort((a, b) => b.mean - a.mean || Math.abs(a.horizon - 20) - Math.abs(b.horizon - 20))[0]

  const ev = best.mean
  let size: Expectancy['size']
  let sizeNote: string
  if (cappedByRisk || forceAvoid || tier === 'avoid') {
    size = 'none'
    sizeNote = 'A red flag / avoid verdict is active — the historical edge does not apply; stay out.'
  } else if (ev <= 0.5) {
    size = 'none'
    sizeNote = 'No positive expectancy in the comparables — nothing to size.'
  } else if (br.lowConfidence || best.lowConfidence || ev < 1.5) {
    size = 'small'
    sizeNote = 'Thin edge or thin sample — starter position only (~1–2% of portfolio).'
  } else if (ev < 3.5 || best.positivePct < 60) {
    size = 'medium'
    sizeNote = 'Decent edge — a normal position (~3–4% of portfolio).'
  } else {
    size = 'full'
    sizeNote = 'Strong, well-sampled edge — a full position (~5% of portfolio); still respect the worst case below.'
  }

  return {
    horizon: best.horizon,
    evPer100: best.mean,
    winRate: best.positivePct,
    typicalWin: best.p75,
    typicalLoss: best.p25,
    worst: br.worstCase?.forwardReturn ?? best.worst,
    n: best.n,
    lowConfidence: br.lowConfidence || best.lowConfidence,
    size,
    sizeNote,
    source: br === baserate.cohort ? 'cohort' : 'self',
  }
}

/** Full signal for one symbol. `fetchIfMissing` lazily backfills deep history on demand. */
export async function computeSignal(symbol: string, opts: { fetchIfMissing?: boolean } = {}): Promise<Signal> {
  const sym = symbol.toUpperCase()
  const asOf = new Date().toISOString()

  if (opts.fetchIfMissing) {
    if ((await deepCloses(sym)).length < 250) await ensureHistory(sym).catch(() => {})
    if ((await deepCloses('^NSEI')).length < 250) await ensureHistory('^NSEI').catch(() => {})
  }

  const [closes, candles, indexCloses, allWatch] = await Promise.all([
    deepCloses(sym),
    deepCandles(sym),
    deepCloses('^NSEI'),
    watchRepo.list(true),
  ])
  const watch = allWatch.find((w) => w.symbol === sym) ?? null
  const cohort = await cohortFor(sym, watch, allWatch)

  // H-11: filings for THIS symbol over the same 120-day window the risk/catalyst factors
  // use — a symbol-scoped, time-windowed query, not a filter over the newest 500 rows
  // market-wide (which spanned only a few days and could miss a dilution/QIP just outside
  // it, letting a name read "high-conviction" days after announcing a raise).
  const filingsSince = new Date(Date.now() - 120 * 864e5).toISOString()
  const filings = await guidanceFilingsRepo.forSymbolSince(sym, filingsSince).catch(() => [])

  // Live news filtered to this ticker (same source the public chat uses).
  let news: { sentimentScore: number; publishedAt: string }[] = []
  try {
    const live = await fetchLiveNews()
    news = live.items.filter((n) => n.tickers.includes(sym)).map((n) => ({ sentimentScore: n.sentimentScore, publishedAt: n.publishedAt }))
  } catch {
    /* news optional */
  }

  let factSheet: FactSheet | null = null
  try {
    factSheet = await getFactSheet(sym)
  } catch {
    /* fundamentals optional */
  }

  // Qualitative layer: recent developments (filings + news) + earnings trend + the deep
  // business-fundamentals (quality axis).
  const [developments, results, quality] = await Promise.all([
    getDevelopments(sym).catch(() => ({ filings: [], news: [], positives: [], negatives: [] }) as Developments),
    getResultsTrend(sym).catch(() => null),
    getFundamentals(sym).catch(() => null),
  ])

  const config = await loadConfig()
  const inst = await getInstrument(sym)

  // ——— factors (apply weight overrides) ———
  const raw = computeFactors({ symbol: sym, closes, candles, indexCloses, cohort, filings, news, factSheet, watch, developments, results })
  const factors = raw.map((f) => {
    const w = config.weights[f.code] ?? f.weight
    return { ...f, weight: w, contribution: f.score * w }
  })

  // ——— composite ———
  const sumW = factors.reduce((a, f) => a + f.weight, 0)
  const sumC = factors.reduce((a, f) => a + f.contribution, 0)
  const normalized = sumW ? sumC / sumW : 0
  let score = Math.round(((normalized + 1) / 2) * 100)

  // ——— market-regime caution: when the broad market is risk-off (NIFTY below its 200-DMA
  // and/or high volatility), trim conviction — dip-buys hardest (falling-knife risk). This
  // directly lowers the odds of "buying into a falling market". ———
  // Trim the EDGE ABOVE NEUTRAL (50), not the whole score. Multiplying the raw 0–100
  // score flattened everything below the constructive cut whenever the market was
  // risk-off (a strong 75-score dip → 41 → "no clear edge, wait"), so the board could
  // literally never say "buy" in a down market — the opposite of what a dip desk is for.
  // Edge-relative caution keeps the intent (75 reads ~64 in risk-off, dips trimmed
  // hardest) while genuinely strong setups can still clear the bar. Sub-50 scores are
  // left untouched — caution must never IMPROVE a weak setup.
  const regime = computeRegime(indexCloses)
  const move1dPre = (factors.find((f) => f.code === 'drop_1d')?.value as number) ?? 0
  const regimeMult = move1dPre < 0 ? regime.dipCautionMult : regime.cautionMult
  if (regimeMult < 1 && score > 50) score = Math.round(50 + (score - 50) * regimeMult)

  // ——— thesis-breaker cap: a fired breaker forces the tier down to at most neutral ———
  const breakers = factors.filter((f) => f.breaksThesis && f.score < 0)
  const cappedByRisk = breakers.length > 0
  if (cappedByRisk) score = Math.min(score, 34)

  const tier = tierFor(score, config.tiers)

  // ——— base rate for the current setup band ———
  // The 1-day move picks BOTH the severity band and the DIRECTION. A move inside the normal
  // daily range (below the mildest band, e.g. a +2% or −1% day) has NO active setup — band
  // is null and the base rate is returned as "no active setup" rather than a mislabelled
  // "3–5% drop" dip-buy (M-G1). Direction is decided by the sign only when a band matches.
  const move1d = (factors.find((f) => f.code === 'drop_1d')?.value as number) ?? 0
  const band = bandForDrop(move1d, config.thresholds.dropBands) // null on a quiet day
  const direction: 'down' | 'up' = move1d >= 0 ? 'up' : 'down'
  const cohortLabel = watch?.tags[0] ? `${watch.tags[0]} cohort (${cohort.length + 1})` : 'cohort'
  // 9.5: point-in-time membership checker (cached in the repo; a cheap in-memory replay of
  // the index_membership ledger). Optional — with an empty ledger the base rate falls back
  // to the survivor-conditioned sample and keeps saying so.
  const membership = await membershipRepo.cachedChecker().catch(() => null)
  // #3: today's setup features — the same numbers the factor stack already computed
  // (RSI from the exhaustion block, drawdown-from-high from the extension block) — so
  // the base rate can match on WHAT TODAY LOOKS LIKE, not just the move-size band.
  const rsiToday = factors.find((f) => f.code === 'exhaustion')?.value
  const ddToday = factors.find((f) => f.code === 'extension')?.value
  const baserate = computeBaseRate({
    symbol: sym,
    selfCloses: closes,
    cohort: cohort.map((p) => ({ symbol: p.symbol, closes: p.closes })),
    cohortLabel,
    band,
    horizons: config.thresholds.horizons,
    direction,
    minSamples: config.thresholds.recoveredMinSamples, // M-G2: thread the config value
    features: { movePct: round2(move1d), rsi14: typeof rsiToday === 'number' ? rsiToday : null, ddFromHighPct: typeof ddToday === 'number' ? ddToday : null }, // #3
    allBands: config.thresholds.dropBands, // #3: the ladder defines the knn pool's mildest edge
    indexCloses, // 9.6: regime-conditioned matching — compare today's dip/pop only to past ones in the same market state
    membership: membership ? { wasMember: membership.wasMember, coverageStart: membership.coverageStart } : undefined, // 9.5
  })

  // ——— #5: expectancy — turn the matched odds into a decision aid ———
  const expectancy = computeExpectancy(baserate, tier, cappedByRisk, quality?.risk.forceAvoid ?? false)

  // ——— group summaries ———
  const groups: GroupSummary[] = GROUP_ORDER.map((g) => {
    const gf = factors.filter((f) => f.group === g)
    const gw = gf.reduce((a, f) => a + f.weight, 0)
    const gc = gf.reduce((a, f) => a + f.contribution, 0)
    return { group: g, score: gw ? round2(gc / gw) : 0, weight: round2(gw), factors: gf }
  }).filter((x) => x.factors.length > 0)

  const deep = await hasDeepHistory(sym)
  const note = !deep
    ? 'Deep multi-year history not yet backfilled for this name — base rates are computed on a short window and flagged low-confidence. Run `npm run guidance:backfill`.'
    : ''

  const readout = buildReadout({ symbol: sym, tier, cappedByRisk, factors, baserate, developments, results, quality, tags: watch?.tags ?? [] })

  // M-G5: persist an audit snapshot of this call (throttled to one per symbol per UTC day
  // inside the repo). This is the calibration/track-record substrate — a nightly job can
  // later join these to forward `prices` to measure realized N-day outcomes per call.
  // Fire-and-forget: never let the audit write affect the response.
  void snapshotsRepo
    .insertDaily({
      symbol: sym,
      asOf,
      dataDate: closes[closes.length - 1]?.date ?? null,
      score,
      tier,
      factors,
      baserate,
      analyst: null,
    })
    .catch(() => {})

  return {
    symbol: sym,
    name: inst?.name ?? watch?.symbol ?? null,
    asOf,
    dataDate: closes[closes.length - 1]?.date ?? null,
    price: closes[closes.length - 1]?.close ?? null,
    score,
    normalized: round2(normalized),
    tier,
    cappedByRisk,
    breaks: breakers.map((b) => b.label),
    factors,
    groups,
    baserate,
    readout,
    developments,
    results,
    quality,
    watch,
    deep,
    note,
    regime,
    expectancy,
  }
}

export interface WatchFlag {
  symbol: string
  name: string | null
  thesis: string | null
  tags: string[]
  price: number | null
  dataDate: string | null
  move1d: number | null
  drawdown52w: number | null
  rsi14: number | null
  sharpMove: boolean // |1d| ≥ 4% or RSI < 30
  deep: boolean
}

/** Fast, DB-only scan of the watchlist for the list view (no network per row). */
export async function scanWatchlist(): Promise<WatchFlag[]> {
  const entries = await watchRepo.list(false)
  const flags: WatchFlag[] = []
  for (const w of entries) {
    const closes = await deepCloses(w.symbol)
    const c = closes.map((x) => x.close)
    const px = c[c.length - 1] ?? null
    const prev = c[c.length - 2] ?? null
    const move1d = px != null && prev != null ? round2(((px - prev) / prev) * 100) : null
    const high = c.length > 1 ? Math.max(...c.slice(-252)) : null
    const drawdown52w = px != null && high ? round2(((px - high) / high) * 100) : null
    const rsi14 = rsiQuick(c, 14)
    flags.push({
      symbol: w.symbol,
      name: w.symbol,
      thesis: w.sectorThesis,
      tags: w.tags,
      price: px,
      dataDate: closes[closes.length - 1]?.date ?? null,
      move1d,
      drawdown52w,
      rsi14,
      sharpMove: (move1d != null && Math.abs(move1d) >= 4) || (rsi14 != null && rsi14 < 30),
      deep: c.length >= 250,
    })
  }
  // Most actionable first: sharp moves, then deepest drawdown.
  return flags.sort((a, b) => Number(b.sharpMove) - Number(a.sharpMove) || (a.drawdown52w ?? 0) - (b.drawdown52w ?? 0))
}

function rsiQuick(c: number[], n: number): number | null {
  if (c.length < n + 1) return null
  let g = 0
  let l = 0
  for (let i = c.length - n; i < c.length; i++) {
    const d = c[i] - c[i - 1]
    if (d >= 0) g += d
    else l -= d
  }
  if (g + l === 0) return 50
  return round2(100 - 100 / (1 + g / (l || 1e-9)))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
