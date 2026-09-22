// Agentic research desk (9.2) — plan → retrieve → synthesize over the app's OWN data.
//
// The grounded chat (chat.ts) stuffs one fixed context into a single LLM call; this
// module instead lets the model DECIDE what to look at: it plans, calls typed tools
// (quotes, price history, NSE filings, news, screener.in fundamentals, industry peers,
// the one-day move explainer), then writes an analyst answer where every claim carries
// an inline (source, date) citation drawn ONLY from tool results. Groq drives the
// tool-calling loop (OpenAI-compatible API — works when Gemini credits are exhausted).
// Budget: max 6 tool calls, 60s wall clock, then a forced text synthesis.
// All SQL stays in the repositories; this module only orchestrates.

import { z } from 'zod'
import { completeWithTools, groqAvailable, type Provider, type ToolDef, type ToolLoopMsg } from './llm'
import { matchInstruments } from './chat'
import { getQuotes } from './quotes'
import { recentClosesDesc, distinctRecentDates, universe } from './repositories/prices'
import * as guidanceFilingsRepo from './repositories/guidanceFilings'
import { companyNews } from './company-feed'
import { getFactSheet } from './fact-sheet'
import { getInstrument } from './repositories/instruments'
import { explainMove } from './explain'

// Budgets: the loop must finish inside one HTTP request. FINISH_RESERVE is how much
// time the final synthesis turn needs — once less than that remains, tools shut off.
const AGENT_DEADLINE_MS = 60_000
const MAX_TOOL_CALLS = 6
const MAX_ITERATIONS = 8 // LLM turns (tool rounds + synthesis); backstop against loops
const FINISH_RESERVE_MS = 15_000
const ATTEMPT_TIMEOUT_MS = 25_000
const TOOL_RESULT_CAP = 5_000 // chars per tool result — keeps Groq payloads small

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 10000) / 100 : 0)
const fmtPct = (n: number | null) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`)
const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

// ——— tool registry ———
// Each tool: zod schema (validated before execution, converted to JSON Schema for the
// model), an executor returning the payload + a source tag (for citations/UI trace).

interface ToolOutput {
  source: string // provenance tag, e.g. 'NSE EOD store' — feeds citations + Sources chips
  summary: string // one human line for the frontend tool trace
  data: unknown // JSON payload handed back to the model
}

interface AgentTool {
  name: string
  description: string
  schema: z.ZodType
  run: (args: Record<string, unknown>) => Promise<ToolOutput>
}

/** zod → JSON Schema for the OpenAI-compatible tools API ($schema key is just noise). */
function toParams(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

const symbolField = z.string().min(1).max(20).describe('NSE symbol, e.g. RELIANCE')

const TOOLS: AgentTool[] = [
  {
    name: 'getQuote',
    description: 'Current (15-min delayed) market price, previous close and day change % for one or more NSE symbols.',
    schema: z.object({ symbols: z.array(symbolField).min(1).max(5).describe('NSE symbols to quote') }),
    run: async (args) => {
      const { symbols } = args as { symbols: string[] }
      const quotes = await getQuotes(symbols.map((s) => s.toUpperCase()))
      return {
        source: 'Yahoo quote (delayed)',
        summary: quotes.length
          ? `getQuote — ${quotes.map((q) => `${q.key} ₹${q.price} (${fmtPct(q.changePct)})`).join(', ')}`
          : `getQuote ${symbols.join(',')} — no quote available`,
        data: quotes.map((q) => ({ symbol: q.key, price: q.price, prevClose: q.prevClose, dayChangePct: q.changePct, asOf: q.marketTime })),
      }
    },
  },
  {
    name: 'getPriceHistory',
    description: 'Recent daily closes from the NSE EOD store with 1-day/1-week/1-month/3-month moves and the window high/low. Use this to see how a stock has been trading.',
    schema: z.object({
      symbol: symbolField,
      days: z.number().int().min(5).max(120).optional().describe('trading days of history (default 65)'),
    }),
    run: async (args) => {
      const { symbol, days } = args as { symbol: string; days?: number }
      const sym = symbol.toUpperCase()
      const rows = await recentClosesDesc(sym, days ?? 65) // newest first
      if (rows.length < 2) return { source: 'NSE EOD store', summary: `getPriceHistory ${sym} — no price history`, data: { symbol: sym, closes: [] } }
      const at = (n: number) => (rows.length > n ? rows[n].close : null)
      const last = rows[0]
      const moves = {
        d1Pct: at(1) != null ? pct(last.close, at(1)!) : null,
        w1Pct: at(5) != null ? pct(last.close, at(5)!) : null,
        m1Pct: at(21) != null ? pct(last.close, at(21)!) : null,
        m3Pct: at(63) != null ? pct(last.close, at(63)!) : null,
      }
      const closes = rows.map((r) => r.close)
      return {
        source: 'NSE EOD store',
        summary: `getPriceHistory ${sym} — ₹${last.close} (${last.date.slice(0, 10)}), 1W ${fmtPct(moves.w1Pct)}, 1M ${fmtPct(moves.m1Pct)}`,
        data: {
          symbol: sym,
          lastClose: last.close,
          lastDate: last.date.slice(0, 10),
          ...moves,
          windowHigh: Math.max(...closes),
          windowLow: Math.min(...closes),
          windowDays: rows.length,
          recentCloses: rows.slice(0, 8).map((r) => ({ date: r.date.slice(0, 10), close: r.close })),
        },
      }
    },
  },
  {
    name: 'getFilings',
    description: 'Official NSE corporate filings/disclosures for a symbol over the last N days (title, category, materiality, AI digest).',
    schema: z.object({
      symbol: symbolField,
      days: z.number().int().min(1).max(120).optional().describe('lookback in days (default 30)'),
    }),
    run: async (args) => {
      const { symbol, days } = args as { symbol: string; days?: number }
      const sym = symbol.toUpperCase()
      const rows = await guidanceFilingsRepo.forSymbolSince(sym, daysAgoIso(days ?? 30))
      const items = rows.slice(0, 12).map((f) => ({
        date: f.filedAt.slice(0, 10),
        category: f.category,
        materiality: f.materiality,
        title: f.title.slice(0, 200),
        summary: f.summary,
      }))
      return {
        source: 'NSE filings',
        summary: `getFilings ${sym} — ${items.length} filing${items.length === 1 ? '' : 's'} in last ${days ?? 30}d`,
        data: { symbol: sym, filings: items },
      }
    },
  },
  {
    name: 'getNews',
    description: 'Recent news headlines about a company (Google News, sentiment-scored) over the last N days.',
    schema: z.object({
      symbol: symbolField,
      days: z.number().int().min(1).max(60).optional().describe('lookback in days (default 14)'),
    }),
    run: async (args) => {
      const { symbol, days } = args as { symbol: string; days?: number }
      const sym = symbol.toUpperCase()
      const inst = await getInstrument(sym)
      const cutoff = daysAgoIso(days ?? 14).slice(0, 10)
      const items = (await companyNews(inst?.name ?? sym, sym))
        .filter((n) => n.publishedAt.slice(0, 10) >= cutoff)
        .slice(0, 10)
        .map((n) => ({ date: n.publishedAt.slice(0, 10), headline: n.headline, source: n.source, sentiment: n.sentiment }))
      return {
        source: 'Google News',
        summary: `getNews ${sym} — ${items.length} headline${items.length === 1 ? '' : 's'} in last ${days ?? 14}d`,
        data: { symbol: sym, news: items },
      }
    },
  },
  {
    name: 'getFactSheet',
    description: 'Fundamentals fact sheet from screener.in: key ratios (P/E, ROE, market cap, dividend yield...), pros/cons, business description.',
    schema: z.object({ symbol: symbolField }),
    run: async (args) => {
      const { symbol } = args as { symbol: string }
      const sym = symbol.toUpperCase()
      const sheet = await getFactSheet(sym)
      if (!sheet) return { source: 'screener.in', summary: `getFactSheet ${sym} — not available`, data: { symbol: sym, factSheet: null } }
      return {
        source: 'screener.in',
        summary: `getFactSheet ${sym} — ${sheet.ratios.length} ratios (as of ${sheet.asOf.slice(0, 10)})`,
        data: {
          symbol: sym,
          asOf: sheet.asOf.slice(0, 10),
          ratios: sheet.ratios,
          pros: sheet.pros,
          cons: sheet.cons,
          about: sheet.about?.slice(0, 400) ?? null,
        },
      }
    },
  },
  {
    name: 'getPeers',
    description: 'Same-industry peers from the NIFTY 500 master, with their latest close and day change — for relative comparisons.',
    schema: z.object({ symbol: symbolField }),
    run: async (args) => {
      const { symbol } = args as { symbol: string }
      const sym = symbol.toUpperCase()
      const inst = await getInstrument(sym)
      if (!inst) return { source: 'NIFTY 500 master', summary: `getPeers ${sym} — symbol not in universe`, data: { symbol: sym, peers: [] } }
      const dates = await distinctRecentDates(2)
      const rows = dates.length >= 2 ? await universe(dates[0], dates[1]) : []
      const peers = rows
        .filter((r) => r.industry === inst.industry && r.symbol !== sym)
        .slice(0, 12)
        .map((r) => ({
          symbol: r.symbol,
          name: r.name,
          close: r.close,
          dayChangePct: r.close != null && r.prevClose != null ? pct(r.close, r.prevClose) : null,
        }))
      return {
        source: 'NIFTY 500 master',
        summary: `getPeers ${sym} — ${peers.length} peers in ${inst.industry}`,
        data: { symbol: sym, industry: inst.industry, asOf: dates[0] ?? null, peers },
      }
    },
  },
  {
    name: 'explainMove',
    description: "Causal explanation of one day's price move for a symbol: move vs NIFTY, same-window filings/news/corporate actions, and a grounded narrative. Best tool for 'why did X move'.",
    schema: z.object({
      symbol: symbolField,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('trading day YYYY-MM-DD (default: latest session)'),
    }),
    run: async (args) => {
      const { symbol, date } = args as { symbol: string; date?: string }
      const sym = symbol.toUpperCase()
      // Models often guess a calendar date that isn't a stored session — fall back to
      // the latest session rather than wasting a tool call on "no data".
      let ex = await explainMove(sym, date)
      if (!ex && date) ex = await explainMove(sym)
      if (!ex) return { source: 'Bharat Market Pro move explainer', summary: `explainMove ${sym} — no data for that day`, data: { symbol: sym, explanation: null } }
      return {
        source: 'Bharat Market Pro move explainer',
        summary: `explainMove ${sym} ${ex.date} — ${fmtPct(ex.movePct)} vs NIFTY ${fmtPct(ex.indexMovePct)}`,
        data: {
          symbol: sym,
          date: ex.date,
          movePct: ex.movePct,
          close: ex.close,
          move5dPct: ex.move5dPct,
          niftyMovePct: ex.indexMovePct,
          narrative: ex.narrative,
          filings: ex.evidence.filings.slice(0, 4),
          news: ex.evidence.news.slice(0, 4),
        },
      }
    },
  },
]

const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toParams(t.schema) }))

// ——— the loop ———

const SYSTEM = (today: string, focus: { symbol: string; name: string; industry: string | null } | null) => `You are the Bharat Market Pro research desk — an autonomous analyst for Indian equities (NIFTY 500). Today is ${today}.${
  focus ? `\nFocus company: ${focus.name} (${focus.symbol})${focus.industry ? `, industry: ${focus.industry}` : ''}.` : ''
}

METHOD:
1. Plan silently which tools answer the question — typically 2-4 of: price history, filings, news, fact sheet, peers, explainMove, quote. For "why did it move this week/month" use getPriceHistory + getFilings + getNews (getQuote's change is ONE day, not a week); explainMove covers a single session — omit its date to get the latest.
2. Call them. Never guess a number you can look up. You have at most ${MAX_TOOL_CALLS} tool calls — spend them on what matters.
3. Then write the answer.

VIEWS (private personal research tool):
- Give a direct, decisive opinion. When the data supports it, state a clear stance — buy / sell / hold / accumulate / avoid / book profits — with the rationale, the key risks, and price levels or targets where you can justify them.
- Don't hedge, don't add compliance or legal disclaimers, and never refuse to give a view.

ANSWER RULES:
- Cite every factual claim inline as (source, date) using ONLY what the tools returned — e.g. "up 4.2% over the month (NSE EOD store, 2026-07-02)" or "P/E of 24 (screener.in, 2026-07-01)".
- Numbers come from tool results only — never invent or recall figures from memory.
- If a tool came back empty, note the gap in one clause and answer from the rest.
- Plain English, concise markdown; a short table when comparing names.`

export interface AgentToolTrace {
  tool: string
  args: Record<string, unknown>
  summary: string
}

export interface AgentAnswer {
  answer: string
  toolTrace: AgentToolTrace[]
  grounded: string[] // unique source tags actually consulted (drives the Sources chips)
  model: string
  provider: Provider
}

/** Parse + validate + execute one model-requested tool call. Never throws — a bad call
 *  becomes an error payload the model can read and route around. */
async function execTool(name: string, rawArgs: string): Promise<{ output: ToolOutput | null; args: Record<string, unknown>; error?: string }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { output: null, args: {}, error: `unknown tool "${name}"` }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs || '{}')
  } catch {
    return { output: null, args: {}, error: 'arguments were not valid JSON' }
  }
  const check = tool.schema.safeParse(parsed)
  if (!check.success) return { output: null, args: (parsed as Record<string, unknown>) ?? {}, error: `invalid arguments: ${check.error.issues.map((i) => i.message).join('; ')}` }
  const args = check.data as Record<string, unknown>
  try {
    return { output: await tool.run(args), args }
  } catch (e) {
    return { output: null, args, error: `tool failed: ${(e as Error).message}` }
  }
}

/**
 * Run the agent for one question. Returns null when no NIFTY 500 company could be
 * resolved (generic market questions belong to the classic grounded chat) or when
 * every LLM attempt failed — callers fall back to /api/chat either way.
 */
export async function runResearchAgent(question: string, symbolArg?: string): Promise<AgentAnswer | null> {
  if (!groqAvailable()) return null

  // Resolve the focus company: explicit symbol wins, else the same name/symbol matcher
  // the grounded chat uses. No company → not an agent question → let the caller fall back.
  let focus: { symbol: string; name: string; industry: string | null } | null = null
  if (symbolArg) {
    const inst = await getInstrument(symbolArg.toUpperCase())
    if (inst) focus = { symbol: inst.symbol, name: inst.name, industry: inst.industry }
  }
  if (!focus) {
    const matched = (await matchInstruments(question))[0]
    if (matched) {
      const inst = await getInstrument(matched.symbol)
      focus = { symbol: matched.symbol, name: matched.name, industry: inst?.industry ?? null }
    }
  }
  if (!focus) return null

  const started = Date.now()
  const deadline = AbortSignal.timeout(AGENT_DEADLINE_MS)
  const today = new Date().toISOString().slice(0, 10)
  const msgs: ToolLoopMsg[] = [
    { role: 'system', content: SYSTEM(today, focus) },
    { role: 'user', content: question },
  ]
  const trace: AgentToolTrace[] = []
  const grounded = new Set<string>()
  let calls = 0

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const timeLeft = AGENT_DEADLINE_MS - (Date.now() - started)
    if (timeLeft <= 0) break
    // Out of tool budget or nearly out of time → force a text synthesis this turn.
    const mustFinish = calls >= MAX_TOOL_CALLS || timeLeft < FINISH_RESERVE_MS
    const res = await completeWithTools(msgs, TOOL_DEFS, {
      maxTokens: mustFinish ? 1100 : 900,
      toolChoice: mustFinish ? 'none' : 'auto',
      timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, Math.max(timeLeft, 5_000)),
      signal: deadline,
    })
    if (!res) return null

    if (res.toolCalls.length && !mustFinish) {
      msgs.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls })
      for (const tc of res.toolCalls) {
        if (calls >= MAX_TOOL_CALLS) {
          msgs.push({ role: 'tool', toolCallId: tc.id, content: 'Tool budget exhausted — answer now from the results you already have.' })
          continue
        }
        calls++
        const { output, args, error } = await execTool(tc.name, tc.arguments)
        if (output) {
          trace.push({ tool: tc.name, args, summary: output.summary })
          grounded.add(output.source)
          msgs.push({
            role: 'tool',
            toolCallId: tc.id,
            content: JSON.stringify({ source: output.source, data: output.data }).slice(0, TOOL_RESULT_CAP),
          })
        } else {
          trace.push({ tool: tc.name, args, summary: `${tc.name} — ${error}` })
          msgs.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error }) })
        }
      }
      continue
    }

    if (res.text) {
      return { answer: res.text, toolTrace: trace, grounded: [...grounded], model: res.model, provider: res.provider }
    }
    // Tool calls arrived on a forced-finish turn, or an empty message — nudge synthesis.
    msgs.push({ role: 'user', content: 'Answer now from the tool results above, with inline (source, date) citations. Do not call more tools.' })
  }
  return null
}
