// LLM analyst block — bull / bear / what-breaks-it, grounded ONLY in the assembled
// factor + base-rate context. It may conclude with a stance, but it must NOT state a
// forward probability or claim something "will" recover: confidence is carried by the
// measured base rate shown to the user, never asserted by the model.
import { complete, routeFor, type ChatMsg } from '../llm'
import type { Signal } from './signal'
import type { BaseRate } from './baserate'

export interface AnalystBrief {
  bull: string
  bear: string
  whatBreaks: string
  stance: string
  model: string | null
  provider: string | null
}

const SYSTEM = `You are a private buy-side analyst working on the owner's OWN capital (a private, self-hosted desk). You may take a stance — e.g. "on balance the setup favors accumulation" — but you must be balanced and rigorously honest:
- Give the strongest BULL case, the strongest BEAR case, and WHAT WOULD HAVE TO GO WRONG to invalidate the setup.
- Ground EVERY point only in the provided factor + base-rate context. Do not invent prices, news, fundamentals or events that aren't in the context.
- You MUST NOT state a forward probability, a price target you can't justify from the context, or say it "will"/"is likely to" recover. Confidence is carried by the historical base rate already shown to the user.
- If a thesis-breaker is present (dilution/QIP, auditor/rating/legal flag, catastrophic drawdown history), weight it heavily and let it temper the stance.
- Your STANCE must be CONSISTENT with the deterministic tier and score given in the context: do NOT argue "strong buy / accumulate aggressively" when the tier is neutral/avoid, and do NOT argue "avoid / stay away" when the tier is high-conviction. You may add nuance and caveats, but you must not contradict the desk's computed stance — the tier is the anchor, your job is to explain and stress-test it.
Return STRICT JSON only: {"bull": string, "bear": string, "whatBreaks": string, "stance": string}. Each value is 1–3 plain-text sentences.`

function brRow(br: BaseRate): string {
  const hs = br.horizons.map((h) => `${h.horizon}d: median ${h.median}%, +ve ${h.positivePct}%, back-to-pre ${h.recoveredTerminalPct}%`).join(' | ')
  const worst = br.worstCase ? `worst ${br.worstCase.forwardReturn}% (${br.worstCase.symbol} ${br.worstCase.date})` : 'n/a'
  return `${br.cohortLabel}: setup "${br.setup}", n=${br.n}${br.lowConfidence ? ' (LOW CONFIDENCE)' : ''}; ${hs}; touched-pre-drop ${br.recoveredTouchPct ?? 'n/a'}%; ${worst}`
}

function buildContext(sig: Signal): string {
  const top = [...sig.factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 16)
  const factorLines = top.map((f) => `- [${f.group}] ${f.label}: ${f.display} (pull ${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(2)}${f.breaksThesis ? ', THESIS-BREAKER' : ''})${f.note ? ` — ${f.note}` : ''} [${f.source}]`).join('\n')
  const breaks = sig.breaks.length ? `THESIS-BREAKERS FIRED: ${sig.breaks.join('; ')}\n` : ''
  const base = [sig.baserate.cohort, sig.baserate.self].filter((b): b is BaseRate => !!b).map(brRow).join('\n')

  const r = sig.results
  const earnings = r && r.direction
    ? `EARNINGS TREND (screener quarterly, as-of ${r.asOfQuarter}): direction ${r.direction}; profit ${r.profitTtmGrowth}% TTM YoY (latest quarter ${r.profitLatestYoY}% YoY); sales ${r.salesTtmGrowth}% TTM YoY.`
    : ''
  const devs = [...sig.developments.positives, ...sig.developments.negatives]
  const devBlock = devs.length
    ? 'RECENT DEVELOPMENTS (real filings + news; [+]=supportive [-]=concerning):\n' +
      devs.map((d) => `- [${d.tone === 'supportive' ? '+' : d.tone === 'concerning' ? '-' : '~'}] ${d.date} (${d.category}): ${(d.summary || d.title).slice(0, 160)}`).join('\n')
    : ''

  return [
    `DETERMINISTIC DESK STANCE (the anchor — do not contradict): tier "${sig.tier}", verdict "${sig.readout.verdict}", composite ${sig.score}/100${sig.cappedByRisk ? ' (capped down by a thesis-breaker)' : ''}.`,
    `Thesis (owner note): ${sig.watch?.sectorThesis ?? 'n/a'}.`,
    breaks + 'TOP FACTORS:\n' + factorLines,
    earnings,
    devBlock,
    'HISTORICAL BASE RATE (measured from our own price history; includes failures):\n' + base,
    sig.deep ? '' : 'NOTE: deep history not backfilled — base rate is on a short window, treat as indicative.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function parseJson(text: string): Pick<AnalystBrief, 'bull' | 'bear' | 'whatBreaks' | 'stance'> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    return {
      bull: String(o.bull ?? ''),
      bear: String(o.bear ?? ''),
      whatBreaks: String(o.whatBreaks ?? ''),
      stance: String(o.stance ?? ''),
    }
  } catch {
    return null
  }
}

export async function analystBrief(sig: Signal): Promise<AnalystBrief | null> {
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `FACTOR CONTEXT for ${sig.symbol} (${sig.name ?? ''}):\n${buildContext(sig)}\n\nWrite the brief as strict JSON.` },
  ]
  const r = await complete(messages, { ...routeFor('chat'), maxTokens: 700, json: true })
  if (!r) return null
  const parsed = parseJson(r.text)
  if (!parsed) return { bull: r.text.slice(0, 600), bear: '', whatBreaks: '', stance: '', model: r.model, provider: r.provider }
  return { ...parsed, model: r.model, provider: r.provider }
}
