// Factor engine — the transparent "why" behind a guidance signal.
//
// Each factor is a single, sourced, dated measurement derived from data we already
// hold (deep prices, filings, live news, screener fundamentals, the curated cohort).
// A factor carries a normalized score in [-1,+1] (bullish positive) and a weight; its
// contribution to the composite is score×weight. Nothing here asserts a forward
// outcome — that honesty lives in the base rate (baserate.ts). Weights are tunable
// via guidance_config; the defaults below are documented and deliberately conservative.
import type { Candle } from '../repositories/guidancePriceHistory'
import type { FilingRow } from '../repositories/filings'
import type { FactSheet } from '../fact-sheet'
import type { WatchEntry } from '../repositories/guidanceWatchlist'
import type { Developments } from './developments'
import type { ResultsTrend } from './results'

export type FactorGroup = 'price' | 'catalyst' | 'news' | 'fundamental' | 'relative' | 'risk'

export interface Factor {
  code: string
  label: string
  group: FactorGroup
  value: number | string | null // raw measured value
  display: string // human-readable
  score: number // normalized [-1,+1], bullish positive
  weight: number // default weight (overridable via config)
  contribution: number // score × weight (signed points into the composite)
  source: string
  asOf: string | null
  note?: string
  breaksThesis?: boolean // true for hard risk flags that should cap conviction down
}

export interface Close {
  date: string
  close: number
}

export interface FactorInput {
  symbol: string
  closes: Close[] // deep, ascending
  candles: Candle[] // deep OHLCV ascending (volume); may be shorter than closes
  indexCloses: Close[] // NIFTY deep ascending
  cohort: { symbol: string; closes: Close[]; tags: string[] }[] // peers sharing a tag
  filings: FilingRow[] // recent filings for this symbol (already filtered)
  news: { sentimentScore: number; publishedAt: string }[] // recent news for this symbol
  factSheet: FactSheet | null
  watch: WatchEntry | null
  developments: Developments | null // classified recent filings + news
  results: ResultsTrend | null // quarterly earnings trend (screener)
}

// ——— small numeric helpers ———
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100)

function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null
  const s = vals.slice(-n)
  return s.reduce((x, y) => x + y, 0) / n
}

function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null
  let gain = 0
  let loss = 0
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  if (gain + loss === 0) return 50
  const rs = gain / (loss || 1e-9)
  return 100 - 100 / (1 + rs)
}

/** Annualized realized volatility (%) from the last n daily log returns. */
function realizedVol(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null
  const rets: number[] = []
  for (let i = closes.length - n; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
  return Math.sqrt(varr) * Math.sqrt(252) * 100
}

function maxOver(closes: number[], n: number): number {
  return Math.max(...closes.slice(-n))
}
function minOver(closes: number[], n: number): number {
  return Math.min(...closes.slice(-n))
}

function mk(
  code: string,
  label: string,
  group: FactorGroup,
  value: number | string | null,
  display: string,
  score: number,
  weight: number,
  source: string,
  asOf: string | null,
  extra?: { note?: string; breaksThesis?: boolean },
): Factor {
  const s = clamp(score)
  return { code, label, group, value, display, score: s, weight, contribution: s * weight, source, asOf, ...extra }
}

// Dilution / capital-raise breakers. (L) Fixes the `authorori` typo and NARROWS the match:
// bare "equity shares" and generic "allotment of equity/shares" were catching routine ESOP
// allotments and non-dilutive corporate housekeeping as if they were QIPs. We now require an
// actual raise/dilution phrase.
const DOWN = /qip|qualified institutions? placement|preferential (allotment|issue)|rights issue|fund ?rais|fresh issue|further public offer|increase in (authorized|authorised)(?: share)? capital|\bdilut/i
const POS_CATALYST = /board meeting|outcome of board|results|financial results|dividend|bonus|buyback|order|contract|awarded|wins|approval/i
const RISK_FILING = /fraud|default|insolvency|resignation of (statutory )?auditor|auditor resign|sebi order|penalty|pledge|encumbr|downgrade|rating.*(revis|downgrad)|lender|nclt|investigation/i

const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
function monthIdx(s: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase())
}
function mkDate(d: number, mi: number, y: number): number | null {
  if (mi < 0 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  return Date.UTC(y, mi, d)
}
/** Extract a SCHEDULED meeting/results date from filing text (Indian NSE formats), so
 *  `catalyst_upcoming` keys on the EVENT date, not the intimation's filing date. */
function extractMeetingDate(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ')
  // "12 june 2026" / "12th june, 2026" / "12 jun 2026"
  let m = t.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MON})[a-z]*,?\\s*(\\d{4})`))
  if (m) return mkDate(+m[1], monthIdx(m[2]), +m[3])
  // "june 12, 2026"
  m = t.match(new RegExp(`(${MON})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})`))
  if (m) return mkDate(+m[2], monthIdx(m[1]), +m[3])
  // "12-06-2026" / "12/06/2026" (Indian DD-MM-YYYY)
  m = t.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/)
  if (m) return mkDate(+m[1], +m[2] - 1, +m[3])
  return null
}

// Parse a screener ratio value (e.g. "28.5", "14.2 %", "₹ 1,234") to a number.
function ratioNum(fs: FactSheet | null, labelMatch: RegExp): number | null {
  if (!fs) return null
  const row = fs.ratios.find((r) => labelMatch.test(r.label))
  if (!row) return null
  const m = row.value.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** Compute the full factor stack for a symbol. Each factor degrades to null gracefully. */
export function computeFactors(input: FactorInput): Factor[] {
  const { closes, candles, indexCloses, cohort, filings, news, factSheet, developments, results } = input
  const F: Factor[] = []
  const c = closes.map((x) => x.close)
  const asOfPrice = last(closes)?.date ?? null
  const px = last(c)
  const prev = c[c.length - 2]

  // ——————————————————— PRICE / TECHNICAL ———————————————————
  //
  // M-G3: the previous stack emitted ~10 separate factors (drop_1d/drop_intraday/
  // drawdown_52w/dist_from_52w_low/rsi_14/vs_ma50/trend_ma/down_run/volume_spike/
  // vol_vs_index + move_vs_index/sector_wide/rel_strength_peers) that were near-restatements
  // of ONE mean-reversion prior — an oversold event lit ~7 of ~15 weight positive at once,
  // so "constructive" was near-automatic. They are collapsed here into a small set of
  // roughly-ORTHOGONAL blocks, each scored ONCE with one weight:
  //   • drop_1d   — the trigger: today's single-day move (also drives the base-rate band).
  //   • extension — how far STRETCHED below trend/highs (mean-reversion ROOM).
  //   • exhaustion— is selling EXHAUSTED (oversold RSI + a down-run), or is it a crash break?
  //   • flow      — PARTICIPATION: capitulation volume + abnormal volatility.
  //   • relative  — is the weakness IDIOSYNCRATIC (fell more than market/peers) and is that a
  //                 clean overreaction or a name-specific problem (can score NEGATIVE).
  // Cutoffs are preserved from the old factors where reasonable but are NOT calibrated — they
  // should be fit against the realized base-rate distribution once enough snapshots exist.

  // Shared raw metrics (computed once, reused across blocks).
  const d1 = px != null && prev != null ? pct(px, prev) : null
  const r14 = rsi(c, 14)
  const ma50 = sma(c, 50)
  const dd52 = px != null && c.length > 252 ? pct(px, maxOver(c, 252)) : null // below 52-wk high (neg)
  const fromLow = px != null && c.length > 252 ? pct(px, minOver(c, 252)) : null
  const vsMa = px != null && ma50 != null ? pct(px, ma50) : null
  let downRun = 0
  for (let i = c.length - 1; i > 0 && c[i] < c[i - 1]; i--) downRun++
  const vols = candles.map((x) => x.volume ?? 0).filter((v) => v > 0)
  const downDay = prev != null && px != null && px < prev

  // drop_1d — the trigger move (kept as its own factor; base-rate direction/band key off it).
  if (d1 != null) {
    // A moderate idiosyncratic dip is a buy SETUP; a crash (<-12%) signals something broke.
    const score = d1 >= 0 ? -0.15 : d1 > -3 ? 0.25 : d1 > -8 ? 0.6 : d1 > -12 ? 0.3 : -0.4
    F.push(mk('drop_1d', '1-day move', 'price', round2(d1), fmtPct(d1), score, 1.0, 'NSE/Yahoo EOD', asOfPrice))
  }

  // extension — distance below trend & highs = room to mean-revert, but a very deep drawdown
  // (<-45%) or a name pinned to its 52-wk low is a falling knife, not room. One score.
  if (dd52 != null || vsMa != null) {
    let s = 0
    const bits: string[] = []
    if (dd52 != null) {
      s += dd52 > -10 ? 0 : dd52 > -25 ? 0.5 : dd52 > -45 ? 0.35 : -0.3
      bits.push(`${fmtPct(dd52)} vs 52-wk high`)
    }
    if (vsMa != null) {
      s += vsMa < -10 ? 0.15 : vsMa < 0 ? 0.05 : -0.1
      bits.push(`${fmtPct(vsMa)} vs 50-DMA`)
    }
    if (fromLow != null && fromLow < 8) { s += 0.1; bits.push('near 52-wk low') } // little cushion left
    F.push(mk('extension', 'Extension below trend', 'price', dd52 != null ? round2(dd52) : (vsMa != null ? round2(vsMa) : null), bits.join(' · '), s, 1.2, 'deep history', asOfPrice, { note: 'how far stretched below trend/highs — mean-reversion room (deep <-45% = falling knife)' }))
  }

  // exhaustion — oversold + a run of down days = sellers exhausted; but a same-day crash
  // (<-12%) is exhaustion turned into a break, so it flips negative.
  if (r14 != null) {
    let s = r14 < 25 ? 0.6 : r14 < 35 ? 0.4 : r14 < 50 ? 0.1 : r14 < 70 ? -0.1 : -0.4
    s += downRun >= 4 ? 0.2 : downRun >= 2 ? 0.08 : 0
    if (d1 != null && d1 < -12) s = Math.min(s, -0.3) // crash, not capitulation
    F.push(mk('exhaustion', 'Selling exhaustion', 'price', round2(r14), `RSI ${r14.toFixed(0)}${downRun >= 2 ? ` · ${downRun}d down` : ''}`, s, 1.0, 'deep history', asOfPrice, { note: 'oversold RSI + consecutive down days = seller exhaustion; a same-day crash (<-12%) reads as a break instead' }))
  }

  // flow — participation: capitulation volume on a down day is bullish for mean-reversion;
  // abnormal volatility vs the index is risk per unit of setup. One score.
  {
    let s = 0
    let disp = ''
    if (vols.length > 21) {
      const avg = sma(vols.slice(0, -1), 20)
      const todayV = last(vols)
      if (avg && todayV) {
        const ratio = todayV / avg
        s += ratio > 2 ? (downDay ? 0.45 : 0.2) : ratio > 1.3 ? 0.1 : 0
        disp = `${ratio.toFixed(2)}× vol${downDay ? ' (down day)' : ''}`
      }
    }
    const rv = realizedVol(c, 20)
    const rvIdx = realizedVol(indexCloses.map((x) => x.close), 20)
    if (rv != null && rvIdx != null && rvIdx > 0) {
      const vr = rv / rvIdx
      s += vr > 2.5 ? -0.2 : vr < 1.2 ? 0.05 : 0
      disp = disp ? `${disp} · ${vr.toFixed(2)}× vol-of-index` : `${vr.toFixed(2)}× vol-of-index`
    }
    if (disp) F.push(mk('flow', 'Volume & volatility', 'price', null, disp, s, 0.6, 'deep history + ^NSEI', asOfPrice, { note: 'capitulation volume on a down day supports a bottom; abnormally high vol vs NIFTY is added risk' }))
  }

  // ——————————————————— RELATIVE / COMPETITOR ———————————————————
  // relative — is the weakness name-specific (fell more than the market/peers)? An
  // idiosyncratic drop with NO negative news is a clean overreaction (bullish); the SAME drop
  // WITH confirming bad news, or with no news at all while already in a 6-month downtrend, is
  // name-specific deterioration and scores NEGATIVE (M-G3: symmetric, not dip-only).
  if (d1 != null && indexCloses.length > 1) {
    const ic = indexCloses.map((x) => x.close)
    const idxMove = pct(ic[ic.length - 1], ic[ic.length - 2])
    const rel = d1 - idxMove
    // cohort context (peers sharing a tag): is the whole cohort down (macro) or just this name?
    let cohortMed: number | null = null
    if (cohort.length >= 2) {
      const win = 5
      const moves = cohort
        .map((p) => { const pc = p.closes.map((x) => x.close); return pc.length > win ? pct(pc[pc.length - 1], pc[pc.length - 1 - win]) : null })
        .filter((x): x is number => x != null)
        .sort((a, b) => a - b)
      if (moves.length) cohortMed = moves[Math.floor(moves.length / 2)]
    }
    const newsAvg = news.length ? news.reduce((a, b) => a + b.sentimentScore, 0) / news.length : null
    const sixMoDown = px != null && c.length > 130 && pct(px, c[c.length - 130]) < -20
    const idiosyncratic = rel < -2
    const sectorWide = cohortMed != null && cohortMed < -3
    let s: number
    let note: string
    if (idiosyncratic && newsAvg != null && newsAvg < -0.2) {
      s = -0.3; note = 'fell more than the market AND news flow is negative — name-specific problem, not a clean overreaction'
    } else if (idiosyncratic && (newsAvg == null || news.length === 0) && sixMoDown) {
      s = -0.15; note = 'fell more than the market with no news to explain it while already in a 6-month downtrend — treat as silent weakness'
    } else if (idiosyncratic) {
      s = 0.4; note = 'fell more than the market with no negative news behind it — the kind of overreaction that can snap back'
    } else if (sectorWide) {
      s = 0.2; note = 'the whole cohort sold off — supports a macro, not company-specific, cause'
    } else {
      s = rel < 0 ? 0.1 : -0.05; note = 'move is broadly in line with the market'
    }
    F.push(mk('relative', 'Idiosyncratic vs market/peers', 'relative', round2(rel), `${fmtPct(rel)} vs NIFTY${cohortMed != null ? ` · cohort ${fmtPct(cohortMed)} (5d)` : ''}`, s, 0.9, 'deep history + ^NSEI + cohort', asOfPrice, { note }))
  }

  // ——————————————————— CATALYST / DISCLOSURE ———————————————————
  const now = Date.now()
  const recentFilings = filings.filter((f) => now - Date.parse(f.filedAt) < 30 * 864e5)
  // (L) `catalyst_upcoming` now keys on the MEETING date parsed from the intimation text —
  // it only fires when the scheduled event is actually AHEAD of us (within ~21 days).
  // Windowing on the FILING date wrongly treated the intimation itself (or a past "outcome"
  // filing) as an upcoming catalyst.
  let upcoming: { filing: FilingRow; meetingMs: number } | null = null
  for (const f of filings) {
    if (!/board meeting|intimation of board|schedul|results/i.test(`${f.category} ${f.title}`)) continue
    const meetingMs = extractMeetingDate(`${f.title} ${f.summary ?? ''}`)
    if (meetingMs != null && meetingMs >= now && meetingMs - now < 21 * 864e5) { upcoming = { filing: f, meetingMs }; break }
  }
  if (filings.length) {
    F.push(mk('catalyst_recent', 'Material filings (30d)', 'catalyst', recentFilings.length, `${recentFilings.length}`, recentFilings.some((f) => POS_CATALYST.test(`${f.category} ${f.title}`)) ? 0.2 : 0, 0.5, 'NSE filings', last(filings)?.filedAt ?? null))
  }
  if (upcoming) F.push(mk('catalyst_upcoming', 'Upcoming results/board meeting', 'catalyst', 'yes', upcoming.filing.category, 0.25, 0.6, 'NSE filings', new Date(upcoming.meetingMs).toISOString(), { note: 'a scheduled near-term event (by meeting date) that can re-rate the setup' }))
  const highMat = recentFilings.filter((f) => f.materiality === 'high').length
  if (filings.length) F.push(mk('high_materiality', 'High-materiality filings (30d)', 'catalyst', highMat, `${highMat}`, 0, 0.3, 'NSE filings', asOfPrice))

  // ——————————————————— NEWS / SENTIMENT ———————————————————
  // Pure news signal only. The old `sentiment_divergence` ("price down but news not
  // negative") and `headline_volume` double-counted the drop already captured by drop_1d /
  // exhaustion; the overreaction-vs-confirmation logic now lives ONCE inside `relative`
  // (which can also score NEGATIVE when news CONFIRMS the fall). (M-G3)
  const recentNews = news.filter((n) => now - Date.parse(n.publishedAt) < 14 * 864e5)
  if (recentNews.length) {
    const avg = recentNews.reduce((a, b) => a + b.sentimentScore, 0) / recentNews.length
    F.push(mk('news_sentiment', 'News sentiment (14d)', 'news', round2(avg), avg.toFixed(2), avg > 0.2 ? 0.2 : avg < -0.3 ? -0.2 : 0.05, 0.6, 'press RSS', last(recentNews)?.publishedAt ?? null))
  }

  // ——————————————————— FUNDAMENTALS (point-in-time screener) ———————————————————
  const pe = ratioNum(factSheet, /\bP\/?E\b|price to earning/i)
  const roe = ratioNum(factSheet, /ROE|return on equity/i)
  const divY = ratioNum(factSheet, /dividend yield/i)
  if (pe != null) F.push(mk('valuation_pe', 'P/E', 'fundamental', pe, pe.toFixed(1), pe > 0 && pe < 12 ? 0.35 : pe < 20 ? 0.15 : pe > 60 ? -0.3 : -0.05, 0.7, 'screener.in', factSheet?.asOf ?? null))
  if (roe != null) F.push(mk('quality_roe', 'ROE %', 'fundamental', roe, `${roe.toFixed(1)}%`, roe > 18 ? 0.3 : roe > 12 ? 0.15 : roe < 6 ? -0.2 : 0, 0.6, 'screener.in', factSheet?.asOf ?? null))
  if (divY != null) F.push(mk('dividend_yield', 'Dividend yield %', 'fundamental', divY, `${divY.toFixed(2)}%`, divY > 4 ? 0.25 : divY > 2 ? 0.1 : 0, 0.4, 'screener.in', factSheet?.asOf ?? null))
  if (factSheet) {
    F.push(mk('pros_cons', 'Screener pros − cons', 'fundamental', factSheet.pros.length - factSheet.cons.length, `${factSheet.pros.length}↑ / ${factSheet.cons.length}↓`, clamp((factSheet.pros.length - factSheet.cons.length) * 0.08), 0.4, 'screener.in', factSheet.asOf))
  }

  // ——————————————————— EARNINGS / RESULTS (is the business getting better?) ———————————————————
  if (results) {
    if (results.profitTtmGrowth != null) {
      const g = results.profitTtmGrowth
      F.push(mk('results_profit_growth', 'Profit growth (TTM YoY)', 'fundamental', g, fmtPct(g), g > 15 ? 0.4 : g > 0 ? 0.2 : g < -10 ? -0.35 : -0.1, 1.0, 'screener.in quarterly', results.asOfQuarter, { note: results.direction === 'improving' ? 'earnings trend improving' : results.direction === 'deteriorating' ? 'earnings trend deteriorating' : undefined }))
    }
    if (results.salesTtmGrowth != null) {
      const g = results.salesTtmGrowth
      F.push(mk('results_sales_growth', 'Sales growth (TTM YoY)', 'fundamental', g, fmtPct(g), g > 12 ? 0.25 : g > 0 ? 0.1 : -0.2, 0.7, 'screener.in quarterly', results.asOfQuarter))
    }
    if (results.profitLatestYoY != null) {
      const g = results.profitLatestYoY
      F.push(mk('earnings_momentum', 'Latest-quarter profit YoY', 'fundamental', g, fmtPct(g), g > 0 ? 0.2 : -0.25, 0.7, 'screener.in quarterly', results.asOfQuarter))
    }
  }

  // ——————————————————— DEVELOPMENTS (corporate actions + news, qualitative) ———————————————————
  if (developments) {
    const pos = developments.positives.length
    const neg = developments.negatives.length
    if (pos + neg > 0) {
      F.push(mk('dev_flow', 'Recent developments (net)', 'catalyst', `${pos}↑ / ${neg}↓`, `${pos} supportive · ${neg} concerning`, clamp((pos - neg) * 0.18), 0.9, 'NSE filings + news', null, { note: neg > pos ? 'concerning developments outweigh supportive' : pos > neg ? 'supportive developments outweigh' : undefined }))
    }
  }

  // ——————————————————— RISK / STRUCTURAL (can break the thesis) ———————————————————
  const dilution = filings.find((f) => DOWN.test(`${f.category} ${f.title}`) && now - Date.parse(f.filedAt) < 120 * 864e5)
  if (dilution) {
    F.push(mk('dilution_flag', 'Capital raise / dilution', 'risk', 'flagged', dilution.category, -0.8, 1.4, 'NSE filings', dilution.filedAt, { breaksThesis: true, note: 'QIP/rights/preferential dilutes per-share recovery — breaks the financials recovery thesis' }))
  }
  const riskFiling = filings.find((f) => RISK_FILING.test(`${f.category} ${f.title}`) && now - Date.parse(f.filedAt) < 120 * 864e5)
  if (riskFiling) F.push(mk('structural_risk', 'Auditor/rating/pledge/legal flag', 'risk', 'flagged', riskFiling.category, -0.7, 1.2, 'NSE filings', riskFiling.filedAt, { breaksThesis: true }))
  // Extreme drawdown — the "Suzlon check", judged on the LAST 4 YEARS ONLY. A decade-old
  // peak-vs-trough (2008/2010 highs → COVID lows) marks nearly every Indian name
  // "high-risk" and says nothing about the stock today, so the window is capped. The
  // measurement carries its own fact (peak ₹/date → trough ₹/date) so the readout never
  // states a bare percentage. Bars moving more than ±40% in a day are vendor data seams
  // (split/bonus adjustment flips — e.g. Yahoo's 2005-07-29 NSE boundary, GPIL/CGCL
  // 2024-01-01), not trades: they reset the running peak instead of counting as a crash.
  if (c.length > 252) {
    const win = closes.slice(-1008) // ~4 trading years
    let peak = win[0]
    let dd = { pct: 0, peak: win[0], trough: win[0] }
    for (let i = 1; i < win.length; i++) {
      const bar = win[i]
      const dayMove = pct(bar.close, win[i - 1].close)
      if (Math.abs(dayMove) > 40) { peak = bar; continue } // data seam — rebase, don't score
      if (bar.close > peak.close) { peak = bar; continue }
      const d = pct(bar.close, peak.close)
      if (d < dd.pct) dd = { pct: d, peak, trough: bar }
    }
    const maxDD = dd.pct
    const fact = maxDD < 0 ? `₹${dd.peak.close.toFixed(1)} (${dd.peak.date}) → ₹${dd.trough.close.toFixed(1)} (${dd.trough.date}), split-adjusted daily closes` : 'no fall from a peak in the window'
    F.push(mk('max_drawdown_hist', 'Worst drawdown (last 4y)', 'risk', round2(maxDD), `${fmtPct(maxDD)} — ${fact}`, maxDD < -75 ? -0.4 : maxDD < -50 ? -0.2 : 0, 0.7, 'deep history, 4y window', asOfPrice, { note: maxDD < -60 ? `crashed hard within the last 4 years (${fact}) — the "can't fall" premise is false for this name` : undefined, breaksThesis: maxDD < -80 }))
  }
  // Multi-quarter downtrend (structural, not a dip)
  if (c.length > 130) {
    const sixMo = pct(px ?? 0, c[c.length - 130])
    F.push(mk('downtrend_6m', '~6-month trend', 'risk', round2(sixMo), fmtPct(sixMo), sixMo < -25 ? -0.3 : sixMo < 0 ? -0.05 : 0.1, 0.6, 'deep history', asOfPrice, { note: sixMo < -30 ? 'sustained decline — could be a value trap, not a dip' : undefined }))
  }
  // Liquidity: avg traded value (avoid illiquid). value ≈ avg(volume × close).
  if (vols.length > 20 && px != null) {
    const avgV = sma(vols, 20) ?? 0
    const tradedCr = (avgV * px) / 1e7 // ₹ crore
    F.push(mk('liquidity', 'Avg traded value (20d)', 'risk', round2(tradedCr), `₹${tradedCr.toFixed(1)} Cr`, tradedCr < 2 ? -0.5 : tradedCr < 10 ? -0.1 : 0.05, 0.6, 'deep history', asOfPrice, { note: tradedCr < 2 ? 'thinly traded — slippage/exit risk' : undefined }))
  }

  return F
}

// ——— display helpers ———
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}
