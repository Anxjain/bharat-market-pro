// Market-regime awareness. A dip in a broad, calm uptrend is a very different bet from
// the same dip in a falling, high-volatility market — the latter is where "buy the dip"
// turns into catching a falling knife. This reads the NIFTY (^NSEI) deep history and
// classifies the regime (trend vs 200-DMA + realized-vol percentile + drawdown), then
// produces a CAUTION multiplier that trims conviction (most on dip-buys) when the market
// is risk-off. Deterministic (price-only, no LLM).

export interface Regime {
  label: 'risk-on' | 'neutral' | 'risk-off'
  trend: 'above' | 'below' // NIFTY vs its 200-DMA
  vsMA200Pct: number
  vol: 'calm' | 'normal' | 'stressed'
  volAnnualPct: number
  drawdownPct: number // NIFTY drawdown from its 252-day high
  cautionMult: number // ≤1: applied to the timing score (dips trimmed hardest in risk-off)
  dipCautionMult: number
  note: string
  asOf: string | null
}

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  let s = 0
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i]
  return s / n
}
/** Annualized realized vol (%) of the last n daily log returns. */
function realizedVol(c: number[], n: number): number | null {
  if (c.length < n + 1) return null
  const rets: number[] = []
  for (let i = c.length - n; i < c.length; i++) {
    if (c[i - 1] > 0 && c[i] > 0) rets.push(Math.log(c[i] / c[i - 1]))
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(varr) * Math.sqrt(252) * 100
}

const NEUTRAL: Regime = {
  label: 'neutral', trend: 'above', vsMA200Pct: 0, vol: 'normal', volAnnualPct: 0,
  drawdownPct: 0, cautionMult: 1, dipCautionMult: 1, note: 'Market regime unavailable — no adjustment applied.', asOf: null,
}

export function computeRegime(indexCloses: { date: string; close: number }[]): Regime {
  const c = indexCloses.map((x) => x.close).filter((x) => x > 0)
  if (c.length < 210) return NEUTRAL
  const last = c[c.length - 1]
  const ma200 = sma(c, 200)
  const vsMA = ma200 ? ((last - ma200) / ma200) * 100 : 0
  const trend: Regime['trend'] = vsMA >= 0 ? 'above' : 'below'

  const rv = realizedVol(c, 20) ?? 0
  // Rank today's 20d vol against its own trailing ~2y distribution (percentile).
  const window = c.slice(-520)
  const hist: number[] = []
  for (let i = 21; i < window.length; i++) {
    const v = realizedVol(window.slice(0, i + 1), 20)
    if (v != null) hist.push(v)
  }
  const pct = hist.length ? hist.filter((v) => v <= rv).length / hist.length : 0.5
  const vol: Regime['vol'] = pct >= 0.8 ? 'stressed' : pct <= 0.4 ? 'calm' : 'normal'

  const hi252 = Math.max(...c.slice(-252))
  const dd = hi252 > 0 ? ((last - hi252) / hi252) * 100 : 0

  const riskOff = trend === 'below' || vol === 'stressed' || dd < -12
  const riskOn = trend === 'above' && vol !== 'stressed' && dd > -8
  const label: Regime['label'] = riskOff ? 'risk-off' : riskOn ? 'risk-on' : 'neutral'

  // Caution: trim conviction in risk-off; dip-buys are trimmed hardest (falling-knife risk).
  const cautionMult = label === 'risk-off' ? 0.7 : label === 'neutral' ? 0.88 : 1
  const dipCautionMult = label === 'risk-off' ? 0.55 : label === 'neutral' ? 0.85 : 1

  const parts = [
    `NIFTY ${trend === 'above' ? 'above' : 'below'} its 200-DMA (${vsMA >= 0 ? '+' : ''}${vsMA.toFixed(1)}%)`,
    `${vol} volatility`,
    dd < -1 ? `${dd.toFixed(1)}% off the 1y high` : 'near highs',
  ]
  const note =
    label === 'risk-off'
      ? `Risk-off: ${parts.join(', ')}. Dip-buys are de-emphasised (falling-knife risk); conviction is trimmed.`
      : label === 'risk-on'
        ? `Risk-on: ${parts.join(', ')}. Full conviction — setups read at face value.`
        : `Neutral: ${parts.join(', ')}. Conviction lightly trimmed.`

  return {
    label, trend, vsMA200Pct: Math.round(vsMA * 10) / 10, vol, volAnnualPct: Math.round(rv * 10) / 10,
    drawdownPct: Math.round(dd * 10) / 10, cautionMult, dipCautionMult, note,
    asOf: indexCloses[indexCloses.length - 1]?.date ?? null,
  }
}
