// LLM adapter — provider-agnostic seam for Bharat Market Pro AI features.
// Two providers behind the SAME public functions (complete / completeJson):
//   · Groq   — OpenAI-compatible Llama/GPT-OSS models, with a rate-limit model chain.
//   · Gemini — Google Generative Language API (gemini-2.5-flash), with Google Search
//              grounding for web-dive.
// Callers pick a provider via opts.provider; if that provider's key is missing or the
// call fails, we transparently fall back to the other available provider.
//
// Keys: read from process.env, or server/.env (KEY=VALUE). Server-side only — never
// sent to the client, never logged. No real key values live in source.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './util/shared'

const here = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(here, '..', '.env')

// Loads any UPPER_SNAKE key from server/.env — covers GROQ_* and GEMINI_*.
loadEnvFile(ENV_PATH)

// ——— config ———
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'
// Each Groq model has its own daily quota — cascade on 429 / failure.
const GROQ_CHAIN = [GROQ_MODEL, 'openai/gpt-oss-120b', 'qwen/qwen3-32b', 'llama-3.1-8b-instant']
const GROQ_WEB_MODEL = 'groq/compound-mini' // built-in web search
/** Cheap, high-quota Groq model for bulk background jobs. */
export const BULK_MODEL = 'llama-3.1-8b-instant'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
// PDF-extraction fallback chain: when the primary model returns 503 (overloaded),
// cascade to these (verified available + capable on factsheet PDFs). Override via
// GEMINI_PDF_FALLBACKS="model-a,model-b".
const GEMINI_PDF_FALLBACKS = (process.env.GEMINI_PDF_FALLBACKS ?? 'gemini-flash-latest,gemini-2.5-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean)
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`

export type Provider = 'groq' | 'gemini'

export function groqAvailable(): boolean {
  return Boolean(process.env.GROQ_API_KEY)
}
export function geminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}
export function llmAvailable(): boolean {
  return groqAvailable() || geminiAvailable()
}

// Boot note (booleans only — never the key value).
if (!llmAvailable()) {
  console.warn('[llm] no provider key set (GROQ_API_KEY / GEMINI_API_KEY) — AI features fall back to rule-based output')
} else {
  if (!groqAvailable()) console.warn('[llm] GROQ_API_KEY not set — Groq disabled')
  if (!geminiAvailable()) console.warn('[llm] GEMINI_API_KEY not set — Gemini disabled, routing to Groq')
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompleteOpts {
  maxTokens?: number
  json?: boolean
  model?: string // provider-specific; only applied to the requested provider
  provider?: Provider // primary provider; falls back to the other if unavailable/failing
  webSearch?: boolean // use the provider's web-grounding (Gemini google_search / Groq compound-mini)
  timeoutMs?: number // per-attempt HTTP timeout (default 30s); shrink for latency-bound chat
  signal?: AbortSignal // H-23: overall per-request deadline threaded through the whole cascade
  toolChoice?: 'auto' | 'none' | 'required' // completeWithTools only — 'none' forces a text answer
}

// H-23: merge a per-attempt timeout with any caller-supplied overall deadline so a
// single stalled provider can't run the cascade for minutes. Once the shared deadline
// fires, every subsequent fetch aborts immediately.
function withDeadline(timeoutMs: number, extra?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs)
  if (!extra) return t
  // AbortSignal.any lands in Node 20.3+ but may predate the project's @types/node — call
  // it through a cast so the build doesn't depend on the lib typing.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([t, extra])
  return extra.aborted ? extra : t // best-effort fallback on older runtimes
}

export interface LlmResult {
  text: string
  model: string
  provider: Provider
  sources?: string[] // web-grounding citations, if any
  truncated?: boolean // PDF extraction: output hit the token ceiling (MAX_TOKENS)
}

function domainOf(uri?: string): string | undefined {
  if (!uri) return undefined
  try {
    return new URL(uri).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

// ——— per-task routing (single source of truth, behind this module) ———
export type LlmTask = 'chat' | 'webDive' | 'deskNote' | 'filingHigh' | 'filingMedium'

interface RouteSpec {
  provider: Provider
  fallback: Provider
  model: string
  web: boolean
}

// Per task: which provider/model leads, who backs it up, and whether to web-ground.
// research chat + web-dive -> Gemini (Google Search grounding); desk notes -> Gemini;
// HIGH-materiality filing digests -> Gemini; MEDIUM bulk -> Groq free (llama-3.1-8b-instant).
const ROUTING: Record<LlmTask, RouteSpec> = {
  chat:         { provider: 'gemini', fallback: 'groq',   model: GEMINI_MODEL, web: false },
  webDive:      { provider: 'gemini', fallback: 'groq',   model: GEMINI_MODEL, web: true },
  deskNote:     { provider: 'gemini', fallback: 'groq',   model: GEMINI_MODEL, web: false },
  filingHigh:   { provider: 'gemini', fallback: 'groq',   model: GEMINI_MODEL, web: false },
  filingMedium: { provider: 'groq',   fallback: 'gemini', model: BULK_MODEL,   web: false },
}

/**
 * Resolve the CompleteOpts for a task: primary provider, its model, and whether to
 * web-ground. Cross-provider fallback still happens inside complete(); model is
 * provider-specific so it only binds when the primary provider answers. Merge extra
 * opts at the call site, e.g. complete(msgs, { ...routeFor('chat'), maxTokens: 700 }).
 */
export function routeFor(task: LlmTask): CompleteOpts {
  const r = ROUTING[task]
  return { provider: r.provider, model: r.model, webSearch: r.web }
}

function routeInfo(task: LlmTask) {
  const r = ROUTING[task]
  return { provider: r.provider, model: r.model, fallback: r.fallback, web: r.web }
}

// ——— Groq provider ———
async function callGroq(model: string, messages: ChatMsg[], opts: CompleteOpts): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 700,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: withDeadline(opts.timeoutMs ?? 30_000, opts.signal),
    })
    if (res.status === 429) {
      console.warn(`[llm] groq ${model} rate-limited — trying next`)
      return null
    }
    if (!res.ok) {
      console.warn(`[llm] groq ${model} HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch (e) {
    console.warn(`[llm] groq ${model} request failed:`, (e as Error).message)
    return null
  }
}

async function runGroq(messages: ChatMsg[], opts: CompleteOpts, model?: string): Promise<LlmResult | null> {
  if (!groqAvailable()) return null
  const web = opts.webSearch ? [GROQ_WEB_MODEL] : []
  const chain = model ? [model, ...GROQ_CHAIN.filter((m) => m !== model)] : GROQ_CHAIN
  for (const m of [...web, ...chain]) {
    const text = await callGroq(m, messages, opts)
    if (text) {
      // Don't fabricate a citation: the compound web model doesn't return grounding
      // URLs, so a hardcoded ['live web search'] label was a fake source (audit L).
      return { text, model: m, provider: 'groq' }
    }
  }
  return null
}

// ——— Gemini provider ———
interface GeminiResp {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] }
  }[]
}

async function runGemini(messages: ChatMsg[], opts: CompleteOpts, model?: string): Promise<LlmResult | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  const useModel = model ?? GEMINI_MODEL
  try {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: opts.maxTokens ?? 700,
        // Disable 2.5-flash "thinking": for grounded factual answers it adds no value
        // but silently eats the output-token budget (→ answers truncated to a heading)
        // and its parts can leak into the text (→ duplicated answers).
        thinkingConfig: { thinkingBudget: 0 },
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      },
    }
    if (sys) body.systemInstruction = { parts: [{ text: sys }] }
    if (opts.webSearch) body.tools = [{ google_search: {} }] // grounding (Gemini 2.x)

    const res = await fetch(GEMINI_URL(useModel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, // key in header, not URL
      body: JSON.stringify(body),
      signal: withDeadline(opts.timeoutMs ?? 30_000, opts.signal),
    })
    if (!res.ok) {
      console.warn(`[llm] gemini ${useModel} HTTP ${res.status}`) // status only — never the body/key
      return null
    }
    const data = (await res.json()) as GeminiResp & { candidates?: { finishReason?: string }[] }
    const cand = data.candidates?.[0]
    const raw = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    // Grounded answers embed inline citation markers ([cite_start], [cite: 1, 2], …);
    // strip them and tidy the whitespace they leave behind.
    const text = raw
      .replace(/\[cite[^\]]*\]/gi, '')
      .replace(/ +([.,;:)])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    if (!text) return null
    const chunks = cand?.groundingMetadata?.groundingChunks ?? []
    const sources = chunks.length
      ? [...new Set(chunks.map((c) => c.web?.title || domainOf(c.web?.uri)).filter((s): s is string => Boolean(s)))].slice(0, 5)
      : undefined
    // M-B16: surface a token-ceiling cutoff so callers can flag a truncated answer.
    const truncated = cand?.finishReason === 'MAX_TOKENS'
    return { text, model: useModel, provider: 'gemini', sources, truncated }
  } catch (e) {
    console.warn(`[llm] gemini ${useModel} request failed:`, (e as Error).message)
    return null
  }
}

// ——— Gemini multimodal: PDF extraction seam (ULIP) ———
/**
 * Send a PDF (as inlineData) + an instruction to Gemini and get text/JSON back.
 * This is the ULIP extraction seam. Gemini-only (Groq has no PDF input); returns
 * null when the key is missing or the call fails, so callers can fall back to a
 * deterministic fixture. Long timeout: fact-sheet PDFs can be large.
 */
export async function completeWithPdf(
  system: string,
  user: string,
  pdf: Buffer,
  opts: { maxTokens?: number; model?: string; timeoutMs?: number; retries?: number } = {},
): Promise<LlmResult | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  // A full ULIP factsheet (40-145 funds × returns/allocations/holdings) needs lots of
  // output tokens — the old 8192 cap truncated the JSON. And 2.5-flash runs "thinking"
  // by default, which on a multi-MB PDF blows past the timeout and surfaces as 503. So:
  // disable thinking + large token budget. When the primary model is OVERLOADED (503),
  // 2.5-flash can take ~140s just to fail — so instead of hammering it, we cascade to
  // less-loaded models (flash-latest, flash-lite) which are usually available.
  const primary = opts.model ?? GEMINI_MODEL
  const models = [primary, ...GEMINI_PDF_FALLBACKS.filter((m) => m !== primary)]
  const maxTokens = opts.maxTokens ?? 65536
  const timeoutMs = opts.timeoutMs ?? 240_000
  const rounds = opts.retries ?? 2 // passes over the whole model chain
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } }, { text: user }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }, // extraction is mechanical — no thinking
    },
  }

  async function tryModel(model: string): Promise<LlmResult | null | 'transient'> {
    try {
      const res = await fetch(GEMINI_URL(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, // key in header, never URL/log
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const transient = res.status === 429 || (res.status >= 500 && res.status <= 504)
        console.warn(`[llm] gemini pdf ${model} HTTP ${res.status}${transient ? ' — cascading to next model' : ''}`)
        return transient ? 'transient' : null
      }
      const data = (await res.json()) as GeminiResp & { candidates?: { finishReason?: string }[] }
      const cand = data.candidates?.[0]
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      const truncated = Boolean(cand?.finishReason && cand.finishReason === 'MAX_TOKENS')
      if (cand?.finishReason && cand.finishReason !== 'STOP') {
        console.warn(`[llm] gemini pdf ${model} finishReason=${cand.finishReason} (output may be incomplete)`)
      }
      if (!text) return 'transient'
      if (model !== primary) console.log(`[llm] gemini pdf extracted via fallback model ${model}`)
      return { text, model, provider: 'gemini', truncated }
    } catch (e) {
      console.warn(`[llm] gemini pdf ${model} request failed: ${(e as Error).message} — cascading to next model`)
      return 'transient'
    }
  }

  for (let round = 0; round < rounds; round++) {
    for (const model of models) {
      const r = await tryModel(model)
      if (r && r !== 'transient') return r // got a real answer
    }
    if (round < rounds - 1) await new Promise((res) => setTimeout(res, 5000 * (round + 1)))
  }
  return null
}

// ——— public API ———

/**
 * One completion. Routes to opts.provider (default gemini), and on missing-key /
 * failure transparently falls back to the other available provider. Returns the
 * text, the model+provider that answered, and any web-grounding sources; null only
 * when every available provider failed.
 */
export async function complete(messages: ChatMsg[], opts: CompleteOpts = {}): Promise<LlmResult | null> {
  const want: Provider = opts.provider ?? 'gemini'
  const order: Provider[] = want === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq']
  for (const p of order) {
    if (p === 'gemini' && !geminiAvailable()) continue
    if (p === 'groq' && !groqAvailable()) continue
    const model = p === want ? opts.model : undefined // model is provider-specific
    const out = p === 'gemini' ? await runGemini(messages, opts, model) : await runGroq(messages, opts, model)
    if (out) return out
  }
  return null
}

// ——— tool-calling (agentic loop driver, 9.2) ———
// Groq is the primary (and currently only) tool-call driver: it speaks the
// OpenAI-compatible tools/function-calling API and keeps working when Gemini credits
// are exhausted. Purely additive — complete()/completeJson()/routeFor() are untouched.
// Gemini function-calling can slot in later behind the same ToolsResult shape.

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments object (e.g. from z.toJSONSchema(...)). */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // raw JSON string, exactly as the model emitted it
}

/** Chat message extended with the two tool-loop roles (assistant tool_calls + tool results). */
export type ToolLoopMsg =
  | ChatMsg
  | { role: 'assistant'; content: string | null; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface ToolsResult {
  text: string | null
  toolCalls: ToolCall[]
  model: string
  provider: Provider
}

/** Our neutral message shape → OpenAI/Groq wire format. */
function toGroqWire(m: ToolLoopMsg): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
    }
  }
  return { role: m.role, content: (m as ChatMsg).content }
}

interface GroqToolsResp {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
}

/**
 * One tool-calling turn: the model either requests tool calls or answers in text.
 * Cascades over the Groq model chain on rate-limit/failure (same policy as runGroq).
 * Returns null only when every model failed — callers treat that as "agent unavailable".
 */
export async function completeWithTools(
  messages: ToolLoopMsg[],
  tools: ToolDef[],
  opts: CompleteOpts = {},
): Promise<ToolsResult | null> {
  if (!groqAvailable()) return null
  const key = process.env.GROQ_API_KEY
  const chain = opts.model ? [opts.model, ...GROQ_CHAIN.filter((m) => m !== opts.model)] : GROQ_CHAIN
  const body: Record<string, unknown> = {
    messages: messages.map(toGroqWire),
    temperature: 0.2,
    max_tokens: opts.maxTokens ?? 900,
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = opts.toolChoice ?? 'auto'
  }
  for (const model of chain) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, model }),
        signal: withDeadline(opts.timeoutMs ?? 30_000, opts.signal),
      })
      if (!res.ok) {
        // 429 = quota, 400 can mean "model doesn't support tools" — either way, next model.
        console.warn(`[llm] groq tools ${model} HTTP ${res.status} — trying next`)
        continue
      }
      const data = (await res.json()) as GroqToolsResp
      const msg = data.choices?.[0]?.message
      if (!msg) continue
      const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
        .filter((tc) => tc.function?.name)
        .map((tc, i) => ({ id: tc.id ?? `call_${i}`, name: tc.function!.name!, arguments: tc.function!.arguments ?? '{}' }))
      const text = msg.content?.trim() || null
      if (!toolCalls.length && !text) continue // empty reply — cascade
      return { text, toolCalls, model, provider: 'groq' }
    } catch (e) {
      console.warn(`[llm] groq tools ${model} request failed:`, (e as Error).message)
      // Overall deadline hit — no point trying further models.
      if (opts.signal?.aborted) return null
    }
  }
  return null
}

function parseJsonLoose<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    const m = text.match(/\{[\s\S]*\}/) // tolerate ```json fences / stray prose
    if (m) {
      try {
        return JSON.parse(m[0]) as T
      } catch {
        /* fall through */
      }
    }
    return null
  }
}

/** Completion that must return a JSON object; null on any failure. */
export async function completeJson<T>(system: string, user: string, opts: CompleteOpts = {}): Promise<T | null> {
  const out = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { ...opts, json: true, maxTokens: opts.maxTokens ?? 400 },
  )
  return out ? parseJsonLoose<T>(out.text) : null
}

/** Provider/model/availability status (booleans only — never key values). */
export function llmInfo() {
  return {
    // backward-compatible "primary" fields (consumed by the existing UI)
    available: llmAvailable(),
    provider: geminiAvailable() ? 'gemini' : 'groq',
    model: geminiAvailable() ? GEMINI_MODEL : GROQ_MODEL,
    // detailed per-provider + per-task routing
    providers: {
      gemini: { available: geminiAvailable(), model: GEMINI_MODEL },
      groq: { available: groqAvailable(), model: GROQ_MODEL, bulkModel: BULK_MODEL },
    },
    // per-task routing with the explicit model each task uses (+ fallback provider)
    routing: {
      chat: routeInfo('chat'),
      webDive: routeInfo('webDive'),
      deskNote: routeInfo('deskNote'),
      filingHigh: routeInfo('filingHigh'),
      filingMedium: routeInfo('filingMedium'),
    },
  }
}
