// Grounded research chat - the LLM answers ONLY from context we assemble out of
// the real data stores (prices, filings, news). The frontend falls back to its
// rule engine if this returns null.
// All SQL lives in the repositories.

import { latestFilings } from './filings-nse'
import { fetchLiveNews } from './news-rss'
import { complete, routeFor, type ChatMsg, type LlmResult, type Provider } from './llm'
import { listSymbolName, getSymbolName } from './repositories/instruments'
import { recentClosesDesc } from './repositories/prices'
import { wordRe } from './util/shared'

// H-23: overall wall-clock budget for one chat request (across the whole cascade).
const CHAT_DEADLINE_MS = 45_000
// Per-attempt HTTP timeout — shorter than the default 30s so a stalled provider
// can't eat the whole budget before we fall back.
const CHAT_ATTEMPT_MS = 20_000

const SYSTEM = `You are the Bharat Market Pro research desk - an assistant for Indian equity market research.

VIEWS (this is a private personal research tool):
- Give direct, decisive opinions. When the data supports it, state a clear stance — buy / sell / hold / accumulate / avoid / book profits — with the rationale, the key risks, and price levels or targets where you can justify them.
- Don't hedge, don't add compliance or legal disclaimers, and never refuse to give a view.

ANSWERING:
- Use the CONTEXT data first - it is live and authoritative; cite its dates ("as of <date>").
- When the context does not cover the question, answer from your general knowledge of Indian markets, companies, sectors and regulations - clearly mark such parts "(background knowledge)". If web search results are available, use them and name the sources.
- NEVER reply that you lack information, that the context/coverage is "small" or "limited", that something is "not in our context", or that you have "no memory" of it. These phrasings are forbidden. When our data doesn't cover the question, answer from web search and general knowledge, then note what live data would sharpen it.
- Don't invent precise live numbers; only the CONTEXT or web results supply current figures.

STYLE:
- Concise markdown. Tables for comparisons. No disclaimers.`

/** Phrases that signal the model hedged/refused instead of answering. Broad on
 *  purpose - any match triggers an automatic web-dive so the user never sees a
 *  "we don't have this / small context" reply (a hard product rule). */
const DENIAL = new RegExp(
  [
    // "...context/coverage/data/memory is small/limited/insufficient/not enough"
    /(context|coverage|data|memory|knowledge)\s+(is\s+|are\s+|seems?\s+|appears?\s+|looks?\s+)?(small|limited|insufficient|incomplete|too\s+(small|limited)|not\s+enough|lacking)/,
    // "small/limited/no context", "no memory", "insufficient data"
    /(small|limited|insufficient|no)\s+(context|coverage|memory|data|knowledge|information)/,
    // "no (specific/further/exact) information/data/details/figures" (soft denial)
    /no\s+(\w+\s+){0,3}(information|data|details?|figures?|specifics?|record|memory)\b/,
    // "information/data/details ... (is) not available"
    /(information|data|details?|figures?|specifics?)\s+(is|are|was|were)?\s*(not|isn'?t|aren'?t)\s+available/,
    // "(does not|doesn't|don't|isn't) (contain|include|provide|have|cover|mention)"
    /(does not|doesn'?t|did not|do not|don'?t|is not|isn'?t|are not|aren'?t)\s+(contain|include|provide|have|cover|mention|show|specify)/,
    // "not in / outside / beyond our|the context/coverage/data/memory/records"
    /(not\s+(in|within|part of|covered by|present in)|outside\s+(of\s+)?|beyond)\s+(our|the|my|this)\s+(context|coverage|data|memory|records|knowledge|scope|dataset)/,
    // "no information/data/record is available/provided/found"
    /no\s+(information|data|memory|record|details?)\s+(is\s+|are\s+|was\s+|were\s+)?(available|provided|present|found)/,
    // "I/we cannot/can't/am unable to/don't have ... find/answer/provide/information"
    /(i|we)\s+(cannot|can'?t|am unable to|are unable to|do not|don'?t)\s+(find|answer|provide|access|have|give)/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
)

/** M-B1: only inspect the opening ~2 sentences for a denial. Genuine grounded
 *  analysis often contains phrases like "the company does not have net debt" mid-answer;
 *  a real hedge/refusal leads. Scanning just the head kills those false positives (which
 *  otherwise discard a correct answer AND burn 3× tokens on needless re-tries). */
function looksLikeDenial(text: string): boolean {
  const head = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')
  return DENIAL.test(head)
}

// M-B13: word-boundary + TTL alias cache (mirrors news-rss.ts) instead of a per-message
// full-table read + substring match ("titan" used to match "titanium"). Rebuilt every 30m.
interface NameAlias { symbol: string; name: string; res: RegExp[] }
let aliasCache: { aliases: NameAlias[]; at: number } | null = null
const ALIAS_TTL_MS = 30 * 60 * 1000

async function getNameAliases(): Promise<NameAlias[]> {
  if (aliasCache && Date.now() - aliasCache.at < ALIAS_TTL_MS) return aliasCache.aliases
  const rows = await listSymbolName()
  const aliases = rows.map((r) => {
    const needles = new Set<string>([r.symbol.toLowerCase()])
    const short = r.name.toLowerCase().replace(/\b(limited|ltd\.?)\b/g, '').trim()
    if (short.length >= 4) needles.add(short)
    return { symbol: r.symbol, name: r.name, res: [...needles].map(wordRe) }
  })
  if (aliases.length > 0) aliasCache = { aliases, at: Date.now() } // don't pin an empty result
  return aliases
}

/** Find instruments mentioned in free text (symbol or name match against NIFTY 500).
 *  Exported for the research agent (9.2), which uses the same resolution to pick its
 *  focus company before entering the tool loop. */
export async function matchInstruments(text: string): Promise<{ symbol: string; name: string }[]> {
  const out: { symbol: string; name: string }[] = []
  for (const a of await getNameAliases()) {
    if (a.res.some((re) => re.test(text))) out.push({ symbol: a.symbol, name: a.name })
    if (out.length >= 4) break
  }
  return out
}

async function quoteBlock(symbol: string): Promise<string | null> {
  const rows = await recentClosesDesc(symbol, 22)
  if (rows.length === 0) return null
  const last = rows[0]
  const prev = rows[1]
  const monthAgo = rows[rows.length - 1]
  const dayChg = prev ? (((last.close - prev.close) / prev.close) * 100).toFixed(2) : 'n/a'
  const monthChg = monthAgo ? (((last.close - monthAgo.close) / monthAgo.close) * 100).toFixed(2) : 'n/a'
  return `${symbol}: close ₹${last.close} (${last.date}), day ${dayChg}%, ~1M ${monthChg}% [NSE EOD]`
}

export async function answerWithLlm(
  messages: ChatMsg[],
  opts?: { symbol?: string; webDive?: boolean },
): Promise<{ answer: string; grounded: string[]; model: string; provider: Provider } | null> {
  const deadline = AbortSignal.timeout(CHAT_DEADLINE_MS) // H-23: shared across the cascade
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  let mentioned = await matchInstruments(lastUser)

  // Company-page chat: always ground in that company, regardless of phrasing.
  if (opts?.symbol) {
    const row = await getSymbolName(opts.symbol.toUpperCase())
    if (row && !mentioned.some((m) => m.symbol === row.symbol)) mentioned = [row, ...mentioned].slice(0, 4)
  }

  const contextParts: string[] = []
  const grounded: string[] = []

  // Real quotes for mentioned instruments
  for (const m of mentioned) {
    const q = await quoteBlock(m.symbol)
    if (q) {
      contextParts.push(q)
      grounded.push(`${m.symbol} NSE EOD`)
    }
  }

  // Recent filings (mentioned companies first, else most recent high-materiality)
  const filings = await latestFilings(200)
  const relevant = mentioned.length
    ? filings.filter((f) => mentioned.some((m) => m.symbol === f.symbol)).slice(0, 8)
    : filings.filter((f) => f.materiality === 'high').slice(0, 8)
  if (relevant.length) {
    contextParts.push(
      'RECENT NSE FILINGS:\n' +
        relevant.map((f) => `- [${f.filedAt.slice(0, 10)}] ${f.company} (${f.category}): ${f.aiSummary ?? f.title.slice(0, 140)}`).join('\n'),
    )
    grounded.push('NSE filings RSS')
  }

  // Live news headlines
  try {
    const news = await fetchLiveNews()
    const items = mentioned.length
      ? news.items.filter((n) => n.tickers.some((t) => mentioned.some((m) => m.symbol === t))).slice(0, 6)
      : news.items.slice(0, 8)
    if (items.length) {
      contextParts.push('LIVE NEWS HEADLINES:\n' + items.map((n) => `- [${n.sentiment}] ${n.headline} (${n.source})`).join('\n'))
      grounded.push('live news feed')
    }
  } catch {
    /* news context optional */
  }

  const context = contextParts.length ? contextParts.join('\n\n') : 'No live data matched this query.'

  // Build the message list. The agentic web model (compound-mini) has a much
  // smaller request budget and 413s on big payloads, so for it we trim both the
  // context and the chat history.
  const buildMessages = (forWeb: boolean): ChatMsg[] => {
    const ctx = forWeb && context.length > 1400 ? context.slice(0, 1400) + '...' : context
    const history = messages.slice(forWeb ? -2 : -8)
    return [
      { role: 'system', content: SYSTEM },
      ...history,
      {
        role: 'user',
        content: `CONTEXT (real data from our stores - prefer it and cite its dates):\n${ctx}\n\nAnswer the last user message.${
          forWeb ? ' If the context is not enough, search the web for current information and say what you found (with source names).' : ''
        }`,
      },
    ]
  }

  // Merge our data-store provenance with any web-grounding citations the model returns.
  // M-B16: when the model hit its token ceiling, flag the answer rather than serve a
  // silently-cut-off reply.
  const finalize = (r: LlmResult) => ({
    answer: r.truncated ? `${r.text.replace(/\s+$/, '')} …\n\n_(answer truncated at the length limit)_` : r.text,
    grounded: r.sources?.length ? [...grounded, ...r.sources] : grounded,
    model: r.model,
    provider: r.provider,
  })

  // Routing: Gemini primary (web-dive uses Gemini's Google Search grounding); the
  // complete() seam transparently falls back to Groq (incl. compound-mini for web)
  // if Gemini errors or its key is unset. All calls share the request deadline (H-23).
  const webDive = () =>
    complete(buildMessages(true), { ...routeFor('webDive'), maxTokens: 900, signal: deadline, timeoutMs: CHAT_ATTEMPT_MS })

  // Explicit "web dive ON" toggle: go to the live web first.
  if (opts?.webDive) {
    const dive = await webDive()
    if (dive && !looksLikeDenial(dive.text)) return finalize(dive)
  }

  // Standard grounded answer (default path).
  const out = await complete(buildMessages(false), { ...routeFor('chat'), maxTokens: 700, signal: deadline, timeoutMs: CHAT_ATTEMPT_MS })

  // HARD RULE: never surface a "we don't have this / small context / no memory"
  // reply. If our stores didn't cover it (out is null or hedged), automatically
  // dive the web ONCE (H-23: capped at one extra attempt so a request can't fan out
  // into minutes of sequential provider calls).
  if (!out || looksLikeDenial(out.text)) {
    const dive = await webDive()
    if (dive && !looksLikeDenial(dive.text)) return finalize(dive)

    // Both paths still hedged (rare) - prefer any non-denial text; otherwise hand
    // off to the caller's offline rule engine rather than show a denial.
    const best = [dive, out].find((r) => r && !looksLikeDenial(r.text))
    return best ? finalize(best) : null
  }

  return finalize(out)
}
