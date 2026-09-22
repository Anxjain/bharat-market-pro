// Plain-English readout — turns the factor stack + base rate into a human answer:
// a verdict ("leans buy"), a one-line bottom line, cause→effect reasons anyone can
// follow, and the base rate phrased as plain odds. The stats stay (below, in the UI);
// this layer explains WHY, so the desk is usable without knowing the jargon.
import type { Factor } from './factors'
import type { BaseRate } from './baserate'
import type { Developments, Development } from './developments'
import type { ResultsTrend } from './results'
import type { Fundamentals } from './fundamentals'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function humanDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso
}

export type ReasonTone = 'up' | 'down' | 'value' | 'warn' | 'info'
export interface Reason {
  tone: ReasonTone // up=bullish, down=oversold-opportunity, value=cheap/quality, warn=risk, info=context
  text: string
  code: string
  // The factual basis the point was laid out from: the measured number + dates + source
  // (a URL where one exists). Every reason must be traceable to real data — no bare claims.
  fact?: string
}
export interface Readout {
  verdict: string
  tone: 'buy' | 'lean-buy' | 'wait' | 'avoid'
  headline: string // the plain odds, one line
  bottomLine: string // 1–2 sentence summary
  reasons: Reason[]
  bullCase: BullCase | null
}

/** The "why this can go up" box: each point is a CLAIM plus the PROOF that verifies it
 *  (the actual number/source/date it came from) — so nothing here is vibes. A point is
 *  only emitted when its underlying data exists; the box is null when no genuine bull
 *  evidence exists at all. */
export interface BullPoint {
  text: string // the claim, plain English
  proof: string // what verifies it: number + source (+ date)
}
export interface BullCase {
  heading: string
  points: BullPoint[] // up to 5, strongest first
  note: string | null // honesty line when the desk still doesn't lean buy
}

function num(f: Factor): number | null {
  return typeof f.value === 'number' ? f.value : null
}

/** Translate a single factor into a plain cause→effect sentence (or null to skip).
 *  Every reason carries its factor's measurement as the fact line (value + source + date)
 *  so the reader can see exactly what the point was laid out from. */
function reasonFor(f: Factor): Reason | null {
  const v = num(f)
  const mk = (tone: ReasonTone, text: string): Reason => ({
    tone,
    text,
    code: f.code,
    fact: `${f.label}: ${f.display} — ${f.source}${f.asOf ? `, as of ${f.asOf}` : ''}`,
  })
  switch (f.code) {
    // ——— M-G3 composite blocks (replace the old drawdown_52w / rsi_14 / dist_from_52w_low /
    //      volume_spike / move_vs_index / sector_wide / sentiment_divergence factors) ———
    case 'extension':
      return v != null && v < -8 ? mk('down', `It's down ${Math.abs(v).toFixed(0)}% from its 1-year high — beaten down, which is where rebounds tend to start if the business is still sound.`) : null
    case 'exhaustion':
      return v != null && v < 35 ? mk('down', `It's technically oversold (RSI ${v.toFixed(0)}) — sellers look exhausted, which often precedes a bounce.`) : v != null && v > 70 ? mk('warn', `It's overbought (RSI ${v.toFixed(0)}) — ran up fast, so it's prone to a pullback.`) : null
    case 'flow':
      return f.score > 0.25 ? mk('down', `Trading volume spiked on the drop — often a sign of capitulation (a selling climax), which can mark a bottom.`) : null
    case 'relative':
      return f.score >= 0.3
        ? mk('down', `It dropped far more than the market did, with no bad news behind it — an outsized fall that can overshoot and snap back.`)
        : f.score <= -0.1
          ? mk('warn', `It fell more than the market ${typeof f.note === 'string' && /confirm|negative/.test(f.note) ? 'and the news flow confirms a real problem' : 'with no news to explain it while already trending down'} — this looks name-specific, not a clean overreaction.`)
          : null
    case 'valuation_pe':
      return v != null && v > 0 && v < 15 ? mk('value', `It's cheap — about ${v.toFixed(0)}× earnings, the kind of level value buyers step in at.`) : v != null && v > 60 ? mk('warn', `It's expensive (${v.toFixed(0)}× earnings) — priced for perfection, with little room for disappointment.`) : null
    case 'dividend_yield':
      return v != null && v > 3 ? mk('value', `It pays a ${v.toFixed(1)}% dividend — you get paid to wait while it recovers.`) : null
    case 'quality_roe':
      return v != null && v > 16 ? mk('up', `It's a genuinely profitable business (ROE ${v.toFixed(0)}%) — quality, not just cheap.`) : v != null && v < 6 ? mk('warn', `Weak profitability (ROE ${v.toFixed(0)}%) — the business itself is struggling.`) : null
    case 'catalyst_upcoming':
      return mk('info', `Results / a board meeting are coming up soon — a near-term event that could move the stock either way.`)
    case 'news_sentiment':
      return v != null && v < -0.3 ? mk('warn', `Recent news flow is negative — sentiment is against it right now.`) : v != null && v > 0.2 ? mk('up', `Recent news flow is positive — sentiment is supportive.`) : null
    case 'dilution_flag':
      return mk('warn', `🚩 The company just announced a capital raise (QIP / rights issue). New shares dilute existing holders and usually push the price down — this is a red flag that outweighs the buy case.`)
    case 'structural_risk':
      return mk('warn', `🚩 There's a serious disclosure (auditor / rating / legal / pledge) — a real warning sign that can keep the price sliding.`)
    case 'max_drawdown_hist':
      // 4y window only — decade-old peaks don't get to label a stock high-risk. The fact
      // line (from the factor display) carries the exact peak ₹/date → trough ₹/date.
      return v != null && v < -55 ? mk('warn', `Heads-up: within the last 4 years this stock has fallen ${Math.min(99, Math.round(Math.abs(v)))}% peak-to-trough. It CAN fall a long way — keep the position sized for that.`) : null
    case 'downtrend_6m':
      return v != null && v < -25 ? mk('warn', `It's been sliding for ~6 months (${v.toFixed(0)}%) — this could be a "falling knife" / value trap rather than a quick dip.`) : null
    case 'liquidity':
      return f.score < -0.3 ? mk('warn', `It's thinly traded — hard to buy or sell without moving the price yourself.`) : null
    default:
      return null
  }
}

function humanHorizon(days: number): string {
  if (days <= 10) return 'about 2 weeks'
  if (days <= 20) return 'about a month'
  if (days <= 40) return 'about 2 months'
  return 'about 3 months'
}

function baseRateHeadline(br: BaseRate | null): string {
  // M-G1: a quiet day (move inside the normal daily range) has no dip/pop to base-rate.
  if (br && br.activeSetup === false) return 'No active setup today — the move is within the normal daily range, so there’s no dip/pop to put historical odds on.'
  if (!br || br.n === 0) return 'There isn’t enough comparable history yet to put real odds on what happens next.'
  const h = br.horizons.find((x) => x.horizon === 20) ?? br.horizons[br.horizons.length - 1]
  if (!h || h.n === 0) return 'There isn’t enough comparable history yet to put real odds on what happens next.'
  const worst = br.worstCase ? br.worstCase.forwardReturn : h.worst
  const caution = br.lowConfidence ? ' — but that’s a small sample, so treat the odds loosely' : ''
  const move = `a typical move of ${h.median >= 0 ? '+' : ''}${h.median}%`
  if (br.direction === 'up') {
    // M-G4: "recoveredTerminalPct" for a pop now means "still above the PRE-POP base" (a
    // distinct, weaker bar than positivePct, which is measured vs the popped entry).
    return `History check: after similar one-day pops, ${br.cohortLabel} were higher ${h.positivePct}% of the time within ${humanHorizon(h.horizon)} (${move}, and still above the pre-pop level ${h.recoveredTerminalPct}% of the time). In the worst case they gave it all back, to ${worst}%. Based on ${br.n} past cases${caution}.`
  }
  return `History check: after similar drops, ${br.cohortLabel} were higher ${h.positivePct}% of the time within ${humanHorizon(h.horizon)} (${move}, and back to the pre-drop price ${h.recoveredTerminalPct}% of the time). In the worst case they kept falling, to ${worst}%. Based on ${br.n} past cases${caution}.`
}

const VERDICT: Record<Readout['tone'], string> = {
  buy: 'Looks like a strong buy setup',
  'lean-buy': 'Leans buy — a constructive setup',
  wait: 'No clear edge — better to wait',
  avoid: 'Best avoided for now',
}
const LEAD: Record<Readout['tone'], string> = {
  buy: 'The evidence points toward buying here.',
  'lean-buy': 'On balance the setup tilts toward buying, with caveats.',
  wait: 'The signals are mixed — there’s no clear reason to act yet.',
  avoid: 'The risks outweigh the setup right now.',
}

/** A specific development → plain reason (uses the real AI summary / headline + date).
 *  The fact carries the actual disclosure link where one exists. */
function devReason(d: Development, tone: ReasonTone): Reason {
  const body = (d.summary || d.title).replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  const tail = tone === 'warn' ? ' — a headwind for the price' : tone === 'up' ? ' — supportive' : ''
  const src = d.kind === 'filing' ? 'Filed' : 'News'
  return {
    tone,
    text: `${src} ${humanDate(d.date)}: ${body}${tail}.`,
    code: `dev:${d.kind}:${d.date}`,
    fact: `${d.kind === 'filing' ? 'NSE filing' : 'News item'}, ${d.date}${d.materiality ? ` (${d.materiality} materiality)` : ''}${d.link ? ` — ${d.link}` : ''}`,
  }
}

function resultsReason(r: ResultsTrend | null): Reason | null {
  if (!r || r.direction == null) return null
  const p = r.profitTtmGrowth
  const q = r.profitLatestYoY
  const qtxt = q != null ? `, latest quarter ${q >= 0 ? '+' : ''}${q}% YoY` : ''
  const fact = `TTM profit ${p != null ? `${p >= 0 ? '+' : ''}${p}%` : '—'}, sales ${r.salesTtmGrowth != null ? `${r.salesTtmGrowth >= 0 ? '+' : ''}${r.salesTtmGrowth}%` : '—'} — screener.in quarterly results${r.asOfQuarter ? ` through ${r.asOfQuarter}` : ''}`
  if (r.direction === 'improving')
    return { tone: 'up', text: `The business is growing — profit is up ${p}% over the past year${qtxt}. Earnings are improving, not just the price.`, code: 'results', fact }
  if (r.direction === 'deteriorating')
    return { tone: 'warn', text: `The business is weakening — profit is down ${Math.abs(p ?? 0)}% over the past year${qtxt}. The earnings themselves are under pressure.`, code: 'results', fact }
  return { tone: 'info', text: `Earnings are mixed — sales ${r.salesTtmGrowth ?? '—'}% and profit ${p ?? '—'}% over the past year${qtxt}.`, code: 'results', fact }
}

/** Business-quality axis → a plain reason, kept distinct from the price/timing setup. */
function qualityReason(q: Fundamentals | null): Reason | null {
  if (!q) return null
  const bits: string[] = []
  if (q.profitCagr3y != null) bits.push(`profit ${q.profitCagr3y >= 0 ? '+' : ''}${q.profitCagr3y}%/yr (3Y)`)
  if (q.roe3y != null) bits.push(`ROE ${q.roe3y}%`)
  if (q.peg != null) bits.push(`PEG ${q.peg}`)
  const detail = bits.length ? ` — ${bits.join(', ')}` : ''
  const fact = `${bits.length ? `${bits.join(', ')} — ` : ''}screener.in financials (P&L/BS/ratios)${q.asOf ? `, as of ${q.asOf.slice(0, 10)}` : ''}`
  if (q.risk.forceAvoid) return { tone: 'warn', text: `Risky fundamentals${detail}: ${q.risk.points.join('; ')}. The business itself is the concern, not the price.`, code: 'quality', fact }
  if (q.qualityTier === 'excellent' || q.qualityTier === 'good')
    return { tone: 'up', text: `Solid business (${q.qualityTier}, ${q.qualityScore}/100${detail}) — the fundamentals support owning it; that's separate from whether today is a good entry.`, code: 'quality', fact }
  if (q.qualityTier === 'weak')
    return { tone: 'warn', text: `Shaky fundamentals (${q.qualityScore}/100${detail}) — the business quality is a worry regardless of the price setup.`, code: 'quality', fact }
  return { tone: 'info', text: `Average business quality (${q.qualityScore}/100${detail}).`, code: 'quality', fact }
}

// Policy-linked sectors (owner tags). India has explicit tailwinds here (e.g. 500 GW
// non-fossil by 2030, PLI, defence indigenisation, rail/infra capex). We treat this as a
// HONEST heuristic — a tailwind only counts when the company is actually executing on it
// (a real recent order win, or sustained sales growth), never as an assumed score.
const POLICY_TAGS = /renewables|infra|defence|energy|psu|wind|rail|solar/i
function policyReason(tags: string[], quality: Fundamentals | null, developments: Developments): Reason | null {
  const sector = tags.find((t) => POLICY_TAGS.test(t))
  if (!sector) return null
  const orderWin = developments.positives.find((d) => /\border|contract|award|\bbag|\bwin/i.test(`${d.category} ${d.title} ${d.summary ?? ''}`))
  const strongGrowth = quality?.salesCagr3y != null && quality.salesCagr3y > 12
  if (orderWin)
    return { tone: 'up', text: `Policy-tailwind sector (India's ${sector} push) and it's executing — order/contract win filed ${orderWin.date}.`, code: 'policy', fact: `NSE filing, ${orderWin.date}: ${orderWin.title.slice(0, 90)}${orderWin.link ? ` — ${orderWin.link}` : ''}` }
  if (strongGrowth)
    return { tone: 'up', text: `Policy-tailwind sector (India's ${sector} push) and executing — sales compounding ${quality!.salesCagr3y}%/yr.`, code: 'policy', fact: `Sales CAGR ${quality!.salesCagr3y}%/yr (3y) — screener.in financials` }
  return { tone: 'info', text: `Policy-tailwind sector (India's ${sector} push), but execution isn't showing yet (no recent orders, growth soft) — the tailwind is a thesis, not a result.`, code: 'policy', fact: `No order/contract filing in recent NSE disclosures; sales CAGR ${quality?.salesCagr3y ?? '—'}%/yr (screener.in)` }
}

export interface ReadoutInput {
  symbol?: string
  tier: 'high-conviction' | 'constructive' | 'neutral' | 'avoid'
  cappedByRisk: boolean
  factors: Factor[]
  baserate: { self: BaseRate; cohort: BaseRate | null }
  developments: Developments
  results: ResultsTrend | null
  quality: Fundamentals | null
  tags: string[]
}

/**
 * Assemble the verifiable bull case. Order: measured odds → beaten-down entry →
 * business quality → earnings direction → real catalyst/policy → valuation. Every
 * point carries its proof; anything without data is simply absent (never padded).
 */
function buildBullCase(input: ReadoutInput, tone: Readout['tone'], br: BaseRate | null, firstWarn: Reason | undefined): BullCase | null {
  const { symbol, factors, developments, results, quality, tags } = input
  const points: BullPoint[] = []
  const fval = (code: string): number | null => {
    const f = factors.find((x) => x.code === code)
    return f && typeof f.value === 'number' ? f.value : null
  }

  // 1) Measured odds — only for a dip setup where history actually favours a bounce.
  if (br && br.activeSetup !== false && br.direction === 'down' && br.n >= 5) {
    const h = br.horizons.find((x) => x.horizon === 20) ?? br.horizons[br.horizons.length - 1]
    if (h && h.n >= 5 && h.positivePct >= 55) {
      const cond = [
        br.regimeConditioned ? 'same market regime as today' : '',
        br.pitCoverage?.conditioned ? 'point-in-time universe' : '',
      ].filter(Boolean).join(', ')
      const who = / only$/.test(br.cohortLabel) ? `${br.cohortLabel.replace(/ only$/, '')} was` : `the ${br.cohortLabel} were`
      points.push({
        text: `History favours a bounce: after similar drops, ${who} higher ${h.positivePct}% of the time within ${humanHorizon(h.horizon)} (median ${h.median >= 0 ? '+' : ''}${h.median}%).`,
        proof: `${h.n} comparable past setups measured on our own stored price history${cond ? ` (${cond})` : ''}; worst case ${br.worstCase ? br.worstCase.forwardReturn + '%' : h.worst + '%'} — not hidden.`,
      })
    }
  }

  // 2) Beaten-down entry — drawdown + oversold RSI (price facts, not opinion).
  const dd = fval('extension')
  const rsi = fval('exhaustion')
  if ((dd != null && dd < -12) || (rsi != null && rsi < 35)) {
    const bits = [
      dd != null && dd < -12 ? `${Math.abs(dd).toFixed(0)}% below its 1-year high` : '',
      rsi != null && rsi < 35 ? `RSI ${rsi.toFixed(0)} (oversold)` : '',
    ].filter(Boolean)
    points.push({
      text: `The entry is beaten-down, not chased: ${bits.join(', ')} — rebounds start from levels like this when the business is sound.`,
      proof: `Computed from official NSE EOD closes in our store${dd != null ? `; 1-yr high distance ${dd.toFixed(1)}%` : ''}.`,
    })
  }

  // 3) Business quality — the "sound business" leg that makes a dip buyable.
  if (quality && !quality.risk.forceAvoid && (quality.qualityTier === 'excellent' || quality.qualityTier === 'good')) {
    const bits = [
      quality.roe3y != null ? `ROE ${quality.roe3y}% (3y)` : '',
      quality.profitCagr3y != null ? `profit ${quality.profitCagr3y >= 0 ? '+' : ''}${quality.profitCagr3y}%/yr (3y)` : '',
      quality.debtToEquity != null ? `D/E ${quality.debtToEquity}` : '',
    ].filter(Boolean)
    points.push({
      text: `It's ${quality.qualityTier === 'excellent' ? 'an' : 'a'} ${quality.qualityTier} business (${quality.qualityScore}/100) — you'd be buying quality on sale, not a falling junk name.`,
      proof: `${bits.join(', ') || 'fundamentals blocks'} — screener.in financials${quality.asOf ? `, as of ${quality.asOf.slice(0, 10)}` : ''}.`,
    })
  }

  // 4) Earnings direction — the price story is backed by the P&L, not just the chart.
  if (results?.direction === 'improving' && results.profitTtmGrowth != null) {
    points.push({
      text: `Earnings are moving the right way: profit up ${results.profitTtmGrowth}% over the past year${results.profitLatestYoY != null ? `, latest quarter ${results.profitLatestYoY >= 0 ? '+' : ''}${results.profitLatestYoY}% YoY` : ''}.`,
      proof: `screener.in quarterly results${results.asOfQuarter ? ` through ${results.asOfQuarter}` : ''}.`,
    })
  }

  // 5) A real, dated catalyst — an actual disclosure, never an assumed one.
  const cat = developments.positives[0]
  if (cat) {
    points.push({
      text: `There's a real supportive development: ${(cat.summary || cat.title).replace(/\s+/g, ' ').trim().replace(/\.$/, '')}.`,
      proof: `${cat.kind === 'filing' ? 'NSE filing' : 'News'}, ${cat.date}${cat.materiality ? ` (${cat.materiality} materiality)` : ''}.`,
    })
  }

  // 6) Policy tailwind — counted only when execution shows (order win or real growth).
  const sector = tags.find((t) => POLICY_TAGS.test(t))
  if (sector && points.length < 5) {
    const orderWin = developments.positives.find((d) => /\border|contract|award|\bbag|\bwin/i.test(`${d.category} ${d.title} ${d.summary ?? ''}`))
    const strongGrowth = quality?.salesCagr3y != null && quality.salesCagr3y > 12
    if (orderWin || strongGrowth) {
      points.push({
        text: `It sits in India's ${sector} policy push AND is executing on it — the tailwind is showing up in real results, not just the story.`,
        proof: orderWin ? `Order/contract win filed ${orderWin.date} (NSE).` : `Sales compounding ${quality!.salesCagr3y}%/yr (3y, screener.in).`,
      })
    }
  }

  // 7) Valuation kicker — only when genuinely cheap or paying you to wait.
  const pe = fval('valuation_pe')
  const dy = fval('dividend_yield')
  if (points.length < 5 && ((pe != null && pe > 0 && pe < 15) || (dy != null && dy > 3))) {
    const bits = [pe != null && pe > 0 && pe < 15 ? `${pe.toFixed(0)}× earnings` : '', dy != null && dy > 3 ? `${dy.toFixed(1)}% dividend yield` : ''].filter(Boolean)
    points.push({
      text: `The price already discounts a lot: ${bits.join(', ')} — value buyers' territory.`,
      proof: 'screener.in ratios vs current price.',
    })
  }

  if (points.length === 0) return null
  const name = symbol ?? 'this stock'
  const heading =
    tone === 'buy' ? `Why ${name} can go up — the case for buying now`
    : tone === 'lean-buy' ? `Why ${name} can go up — what tilts the desk toward buying`
    : `The bull case for ${name} — and why the desk still isn't calling it a buy`
  const note =
    tone === 'buy' || tone === 'lean-buy'
      ? null
      : firstWarn
        ? `Held back because: ${firstWarn.text.replace(/^🚩\s*/, '')}`
        : 'Held back: the overall evidence (score across all factors) doesn’t clear the buy bar yet.'
  return { heading, points: points.slice(0, 5), note }
}

export function buildReadout(input: ReadoutInput): Readout {
  const { tier, cappedByRisk, factors, baserate, developments, results, quality, tags } = input

  // verdict tone — a fired red flag can’t read as buy/lean-buy.
  let tone: Readout['tone'] = tier === 'high-conviction' ? 'buy' : tier === 'constructive' ? 'lean-buy' : tier === 'neutral' ? 'wait' : 'avoid'
  if (cappedByRisk && (tone === 'buy' || tone === 'lean-buy')) tone = 'wait'
  const verdict = VERDICT[tone] + (cappedByRisk ? ' — a red flag is holding it back' : '')

  // factor-derived reasons (price / valuation / risk), biggest pull first.
  const fr: Reason[] = []
  for (const f of [...factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))) {
    const r = reasonFor(f)
    if (!r) continue
    if (r.tone !== 'warn' && fr.filter((x) => x.tone === r.tone).length >= 2) continue
    fr.push(r)
    if (fr.length >= 6) break
  }
  // qualitative reasons — business quality + policy tailwind + earnings trend + developments.
  const qr = qualityReason(quality)
  const pr = policyReason(tags, quality, developments)
  const rr = resultsReason(results)
  const dev: Reason[] = [
    ...developments.positives.slice(0, 2).map((d) => devReason(d, 'up')),
    ...developments.negatives.slice(0, 2).map((d) => devReason(d, 'warn')),
  ]
  // Lead with the setup (top price/value reasons), then the business (quality + policy +
  // earnings), then the real developments, then the rest — reads like a person explaining it.
  const reasons: Reason[] = [...fr.slice(0, 2), ...(qr ? [qr] : []), ...(pr ? [pr] : []), ...(rr ? [rr] : []), ...dev, ...fr.slice(2)].slice(0, 10)

  const br = baserate.cohort && baserate.cohort.n >= baserate.self.n ? baserate.cohort : baserate.self
  const headline = baseRateHeadline(br)

  const firstUp = reasons.find((r) => r.tone === 'up' || r.tone === 'value' || r.tone === 'down')
  const firstWarn = reasons.find((r) => r.tone === 'warn')
  const bottomLine = [
    LEAD[tone],
    firstUp ? firstUp.text.replace(/^🚩\s*/, '') : '',
    firstWarn ? `The catch: ${firstWarn.text.replace(/^🚩\s*/, '')}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const bullCase = buildBullCase(input, tone, br, firstWarn)

  return { verdict, tone, headline, bottomLine, reasons, bullCase }
}
