// Bharat Market Pro API server - the adapter layer between the React app and data sources.
// Every endpoint returns the EXACT TypeScript shapes the frontend already uses
// (src/data/*), so swapping mock -> live is invisible to the UI.
//
// Live today:  /api/news (RSS aggregation over Indian business press)
// Mock today:  companies, market, risks (replaced by vendors in later phases)
//
// Run: npm run dev (port from PORT env, default 9787 for this copy).
// MOCK_MODE=true forces mock everywhere (demo/offline). Data persists in Postgres
// (DATABASE_URL); schema is applied automatically on boot.

import './load-env'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cron from 'node-cron'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { news as mockNews } from '../../src/data/news'
import { filings } from '../../src/data/filings'
import * as insurerKpisRepo from './repositories/insurerKpis'
import { fetchLiveNews } from './news-rss'
import { getEquityCandles, getIndexCandles, getUniverse, priceStoreStatus } from './prices'
import { refreshFilings, enrichFilings, latestFilings } from './filings-nse'
import { answerWithLlm } from './chat'
import { runResearchAgent } from './research-agent'
import { llmInfo } from './llm'
import { getQuotes } from './quotes'
import { companyFeed } from './company-feed'
import { explainMove } from './explain'
import { listAlerts, createAlert, setAlertActive, deleteAlert, evaluateAlerts } from './alerts'
import { alertRulesApi } from './alert-rules-api'
import { getFactSheet } from './fact-sheet'
import { ensureSchema } from './db/migrate'
import { getInstrument } from './repositories/instruments'
import { ulipApi } from './ulip/api'
import { guidanceApi } from './guidance/api'
import { pool } from './db/client'
import { startScheduler } from './scheduler'
import { userFromAuthHeader, authEnabled } from './auth'
import * as watchlistsRepo from './repositories/watchlists'
import { staleSymbols } from './repositories/factSheets'

const MOCK_MODE = process.env.MOCK_MODE === 'true'
const PORT = Number(process.env.PORT ?? 9787)

const app = new Hono()
app.use('*', cors())

// H-5 / M-B8: derive a TRUSTED client IP. A client can freely set X-Forwarded-For, so
// the leftmost hop is spoofable (defeats the limiter). Behind a known reverse proxy
// (TRUST_PROXY=true), the RIGHT-most XFF hop is the one our proxy appended = the real
// client; otherwise fall back to the socket peer (unspoofable). Never trust leftmost.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1'
function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for')
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
      if (hops.length) return hops[hops.length - 1] // right-most = added by our proxy
    }
  }
  // Socket peer (via @hono/node-server's env.incoming). Unspoofable by the client.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress ?? 'local'
}

/** Reusable per-IP sliding-window limiter. Exported so other mounts (e.g. /api/ulip/*)
 *  can share the same trusted-IP logic. Sweeps stale IP entries periodically (M-B8). */
export function rateLimiter(limit: number, windowMs: number): MiddlewareHandler {
  const hits = new Map<string, number[]>()
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [ip, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs)
      if (live.length) hits.set(ip, live)
      else hits.delete(ip)
    }
  }, windowMs)
  if (typeof sweep.unref === 'function') sweep.unref() // don't keep the process alive
  return async (c, next) => {
    const ip = clientIp(c)
    const now = Date.now()
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs)
    if (arr.length >= limit) return c.json({ error: 'rate limit exceeded — try again shortly' }, 429)
    arr.push(now)
    hits.set(ip, arr)
    await next()
  }
}

// In-memory rate limit on the AI endpoint (protects LLM spend). Per-IP sliding window.
const CHAT_LIMIT = Number(process.env.CHAT_RATE_LIMIT ?? 20)
const CHAT_WINDOW_MS = 60_000
export const chatRateLimiter = rateLimiter(CHAT_LIMIT, CHAT_WINDOW_MS)
app.use('/api/chat', chatRateLimiter)
app.use('/api/ulip/chat', chatRateLimiter) // ULIP chat is public but calls paid LLMs (H-5)

app.get('/api/health', async (c) => {
  let db = false
  try { await pool.query('select 1'); db = true } catch { /* db down */ }
  // Return 503 when the DB is unreachable so uptime monitors + deploy.sh see a real
  // failure (a 200 with db:false reads as healthy to a plain HTTP check).
  return c.json(
    { ok: db, service: 'bharat-market-pro-api', mockMode: MOCK_MODE, db, auth: authEnabled(), time: new Date().toISOString() },
    db ? 200 : 503,
  )
})

// --- Listed-insurer KPIs (REAL, sourced from the DB — was illustrative sample data) ---
app.get('/api/insurer-kpis', async (c) => {
  const rows = await insurerKpisRepo.list()
  return c.json({ source: 'real', kpis: rows })
})

// --- LIVE endpoint: NSE corporate filings (official disclosure RSS) + AI digests ---
app.get('/api/filings', async (c) => {
  if (!MOCK_MODE) {
    try {
      await refreshFilings()
      enrichFilings().catch((e) => console.warn('[filings] enrich failed:', e)) // async, non-blocking
      const live = await latestFilings()
      if (live.length > 0) return c.json({ source: 'live', llm: llmInfo(), filings: live })
    } catch (err) {
      console.error('[filings] live fetch failed, serving mock:', err)
    }
  }
  return c.json({ source: 'mock', filings })
})

// --- AI research chat (grounded in real stores; 503 -> frontend rule-engine fallback) ---
app.post('/api/chat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { messages?: { role: string; content: string }[]; symbol?: string; webDive?: boolean }
    | null
  const messages = (body?.messages ?? []).filter(
    (m): m is { role: 'user' | 'assistant'; content: string } =>
      (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
  )
  if (messages.length === 0) return c.json({ error: 'messages required' }, 400)
  const result = await answerWithLlm(messages, { symbol: body?.symbol, webDive: body?.webDive })
  if (!result) return c.json({ error: 'llm unavailable' }, 503)
  return c.json({ source: 'llm', ...result })
})

// --- 9.2 Agentic research desk: plan → tools → cited synthesis. Same JSON transport as
// /api/chat; 503 (or no company matched) -> frontend falls back to the classic chat. ---
app.use('/api/research-agent', chatRateLimiter) // same LLM-spend guard as /api/chat
app.post('/api/research-agent', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { question?: string; symbol?: string } | null
  const question = (body?.question ?? '').trim()
  if (!question) return c.json({ error: 'question required' }, 400)
  const result = await runResearchAgent(question, body?.symbol)
  if (!result) return c.json({ error: 'agent unavailable or no company matched' }, 503)
  return c.json({ source: 'agent', ...result })
})

// --- REAL endpoints: NSE EOD prices from the local store (npm run ingest) ---
app.get('/api/prices/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  const candles = MOCK_MODE ? [] : await getEquityCandles(symbol)
  return c.json({ source: candles.length ? 'real' : 'mock', symbol: symbol.toUpperCase(), candles })
})

app.get('/api/index-prices/:name', async (c) => {
  const name = c.req.param('name')
  const candles = MOCK_MODE ? [] : await getIndexCandles(name)
  return c.json({ source: candles.length ? 'real' : 'mock', name, candles })
})

app.get('/api/universe', async (c) => {
  if (MOCK_MODE) return c.json({ source: 'mock', asOf: null, rows: [] })
  const u = await getUniverse()
  return c.json({ source: u.rows.length ? 'real' : 'mock', ...u })
})

app.get('/api/status', async (c) => c.json({ mockMode: MOCK_MODE, llm: llmInfo(), priceStore: await priceStoreStatus() }))

// --- Real-time(ish) quotes: NSE equities + Indian indices (delayed, labeled) ---
app.get('/api/quotes', async (c) => {
  const keys = (c.req.query('keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (keys.length === 0) return c.json({ error: 'keys required' }, 400)
  const quotes = await getQuotes(keys)
  return c.json({ source: 'yahoo-delayed', quotes })
})

// --- Price alerts: create, list (with history), toggle, delete; evaluated live ---
app.get('/api/alerts', async (c) => {
  // M-B6: fire-and-forget — don't block the list response on a live quote round-trip
  // (evaluateAlerts is single-flight now, so this can't stack up).
  evaluateAlerts().catch(() => {})
  return c.json({ ...(await listAlerts(c.req.query('symbol') || undefined)) })
})

// AUDIT FIX (2026-07-14): alert mutations were fully public — any caller could create,
// toggle or delete any alert by id. A valid login is now required (no-op when auth
// isn't configured, i.e. local dev). Reads stay public.
const requireLogin: MiddlewareHandler = async (c, next) => {
  if (!authEnabled()) return next()
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  if (!user) return c.json({ error: 'login required' }, 401)
  await next()
}
app.use('/api/alerts', async (c, next) => (c.req.method === 'GET' ? next() : requireLogin(c, next)))
app.use('/api/alerts/:id', async (c, next) => (c.req.method === 'GET' ? next() : requireLogin(c, next)))

app.post('/api/alerts', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { symbol?: string; condition?: string; price?: number } | null
  if (!body?.symbol || (body.condition !== 'above' && body.condition !== 'below') || typeof body.price !== 'number' || body.price <= 0) {
    return c.json({ error: 'symbol, condition (above|below) and positive price required' }, 400)
  }
  try {
    return c.json({ alert: await createAlert(body.symbol, body.condition, body.price) })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.patch('/api/alerts/:id', async (c) => {
  // L: validate the id (Number('abc') → NaN) and require an explicit boolean — an empty
  // body used to silently deactivate the alert (Boolean(undefined) === false).
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid alert id' }, 400)
  const body = (await c.req.json().catch(() => null)) as { active?: boolean } | null
  if (typeof body?.active !== 'boolean') return c.json({ error: 'active (boolean) required' }, 400)
  await setAlertActive(id, body.active)
  return c.json({ ok: true })
})

app.delete('/api/alerts/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid alert id' }, 400)
  await deleteAlert(id)
  return c.json({ ok: true })
})

// --- Rule-based custom alerts (9.7): condition sets evaluated nightly, sub-app ---
app.route('/api/alert-rules', alertRulesApi)

// --- Company fact sheet (screener.in, cached 24h, attributed) ---
app.get('/api/fact-sheet/:symbol', async (c) => {
  const sheet = await getFactSheet(c.req.param('symbol'))
  if (!sheet) return c.json({ error: 'fact sheet unavailable' }, 404)
  return c.json(sheet)
})

// --- Per-company feed: news + corporate actions + announcements + risk + desk note ---
app.get('/api/company-feed/:symbol', async (c) => {
  const feed = await companyFeed(c.req.param('symbol'))
  if (!feed) return c.json({ error: 'not in universe' }, 404)
  return c.json({ source: 'live', ...feed })
})

// --- "Explain this move": grounded one-day causal narrative (9.4) ---
// AUDIT FIX (2026-07-14): this calls a paid LLM per request — same spend guard as chat.
app.use('/api/explain/:symbol', chatRateLimiter)
app.get('/api/explain/:symbol', async (c) => {
  const explanation = await explainMove(c.req.param('symbol'), c.req.query('date') || undefined)
  if (!explanation) return c.json({ error: 'symbol not in universe, or no price row for that date' }, 404)
  return c.json(explanation)
})

// --- Single-instrument universe lookup (any NIFTY 500 symbol) ---
app.get('/api/universe/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const row = await getInstrument(symbol)
  if (!row) return c.json({ error: 'not in universe' }, 404)
  return c.json({ source: 'real', ...row })
})

// --- LIVE endpoint: aggregated Indian market news + NSE exchange wire on top ---

/** Recent exchange disclosures (high/medium materiality) as priority news items. */
async function exchangeWire(hours = 36, limit = 12) {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString()
  return (await latestFilings(200))
    .filter((f) => f.filedAt >= cutoff && f.materiality !== 'low')
    .slice(0, limit)
    .map((f) => ({
      id: `xw-${f.id}`,
      headline: `${f.company}: ${f.category}`,
      source: `${f.exchange} · Exchange`,
      publishedAt: f.filedAt,
      tickers: f.symbol ? [f.symbol] : [],
      sentiment: 'neutral' as const,
      sentimentScore: 0,
      summary: f.aiSummary ?? f.title.slice(0, 240),
      tier: 'exchange' as const,
      link: f.link,
    }))
}

app.get('/api/news', async (c) => {
  if (!MOCK_MODE) {
    try {
      const live = await fetchLiveNews()
      if (live.items.length > 0) {
        return c.json({
          source: 'live',
          fetchedAt: live.fetchedAt,
          feeds: live.sources,
          news: [...(await exchangeWire()), ...live.items],
        })
      }
    } catch (err) {
      console.error('[news] live fetch failed, serving mock:', err)
    }
  }
  return c.json({ source: 'mock', news: mockNews })
})

// --- Optional accounts: watchlist sync (Supabase-verified JWT) ---
app.get('/api/auth/config', (c) => c.json({ enabled: authEnabled(), provider: 'supabase' }))

app.get('/api/watchlist', async (c) => {
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ symbols: (await watchlistsRepo.get(user.sub)) ?? [] })
})

app.put('/api/watchlist', async (c) => {
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as { symbols?: unknown[] } | null
  const symbols = Array.isArray(body?.symbols) ? body!.symbols.filter((x): x is string => typeof x === 'string') : []
  return c.json({ symbols: await watchlistsRepo.set(user.sub, user.email, symbols) })
})

// MERGE local (anonymous) watchlist into the account — never wipes what's saved.
app.post('/api/watchlist/merge', async (c) => {
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as { symbols?: unknown[] } | null
  const incoming = Array.isArray(body?.symbols) ? body!.symbols.filter((x): x is string => typeof x === 'string') : []
  return c.json({ symbols: await watchlistsRepo.merge(user.sub, user.email, incoming) })
})

// --- ULIP Insurance Monitor API (read + Excel exports), mounted as a sub-app ---
app.route('/api/ulip', ulipApi)

// --- Investment Guidance (PRIVATE, owner-only). The sub-app self-gates: every route
// 404s when GUIDANCE_ENABLED is off or the caller isn't a verified owner, so mounting
// it here changes nothing for the public app. ---
app.route('/api/guidance', guidanceApi)

// --- Production: serve the built frontend (server/dist) from this same process ---
// One process = whole app. In dev the Vite server proxies /api here instead.
// Resolve dist relative to THIS file (server/src), not the process CWD, so the
// server always serves its own server/dist regardless of where it was launched.
const DIST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
// L: an unmatched /api/* request must return a JSON 404 — NOT the SPA's index.html
// (which 200'd for typo'd endpoints, and let the guidance gate be fingerprinted). This
// sits after every real /api route + sub-app mount, so only genuine misses reach it.
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))
app.use('/*', serveStatic({ root: DIST_ROOT }))
app.get('*', serveStatic({ path: join(DIST_ROOT, 'index.html') }))

// Self-healing fact-sheet/logo coverage: each cycle refresh the few stalest (or
// never-fetched) instruments. ~6/cycle x 12 cycles/hr cycles the full 500 in a day,
// so coverage stays fresh without a burst. `npm run warm` does the initial bulk fill.
const FACTSHEET_BATCH = 6
async function warmStaleFactSheets() {
  const stale = await staleSymbols(FACTSHEET_BATCH)
  for (const symbol of stale) {
    await getFactSheet(symbol).catch(() => {}) // caches sheet + persists logo domain
    await new Promise((r) => setTimeout(r, 1200))
  }
}

// --- Background warmer: keep news + filings caches fresh and AI digests flowing ---
// H-19: overlap guard. A full cycle (news + filings + enrich up to 8 LLM calls +
// factsheet warm) can exceed the 5-min interval; without a flag, overlapping cycles
// would double-issue Gemini/Groq calls and screener scrapes on the same rows.
let warming = false
async function warm() {
  if (warming) return
  warming = true
  try {
    // L: run independent steps under Promise.allSettled so one failure doesn't skip the
    // rest. Filings enrich is chained after its refresh (it reads the freshly-upserted rows).
    const steps: { name: string; run: Promise<unknown> }[] = [
      { name: 'news', run: fetchLiveNews() },
      {
        name: 'filings',
        run: refreshFilings()
          .then(() => enrichFilings())
          .then((n) => { if (n > 0) console.log(`[warm] enriched ${n} filings`) }),
      },
      { name: 'alerts', run: evaluateAlerts().then((fired) => { if (fired > 0) console.log(`[warm] ${fired} alerts fired`) }) },
      { name: 'factsheets', run: warmStaleFactSheets() },
    ]
    const results = await Promise.allSettled(steps.map((s) => s.run))
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`[warm] ${steps[i].name} failed:`, (r.reason as Error)?.message ?? r.reason)
    })
  } finally {
    warming = false
  }
}

export async function start() {
  await ensureSchema() // apply Drizzle migrations to this copy's Postgres
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`Bharat Market Pro server listening on http://localhost:${info.port} (mockMode=${MOCK_MODE})`)
    console.log('Serving API + built frontend. LAN users can open http://<this-machine-ip>:' + info.port)
  })
  let warmTimer: ReturnType<typeof setTimeout> | undefined
  let warmInterval: ReturnType<typeof setInterval> | undefined
  if (!MOCK_MODE) {
    warmTimer = setTimeout(warm, 5_000) // first pass shortly after boot
    warmInterval = setInterval(warm, 5 * 60 * 1000)
  }
  startScheduler() // daily ULIP month-rollover check (self-gates via env)

  // M-S6: graceful shutdown. Every deploy sends SIGTERM; without a handler in-flight
  // requests are dropped and a mid-write cron can leave a partial ULIP month. Stop the
  // warm timers + all cron tasks, close the HTTP server, then drain the DB pool.
  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] ${sig} received — closing gracefully`)
    if (warmTimer) clearTimeout(warmTimer)
    if (warmInterval) clearInterval(warmInterval)
    try { for (const task of cron.getTasks().values()) task.stop() } catch { /* ignore */ }
    try { await new Promise<void>((resolve) => server.close(() => resolve())) } catch { /* ignore */ }
    try { await pool.end() } catch { /* ignore */ }
    process.exit(0)
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
}

export { app }

// Auto-start only when run directly (tsx src/index.ts), not when imported by a test.
if (process.argv[1]?.endsWith('index.ts')) {
  start().catch((e) => {
    console.error('[boot] startup failed:', e)
    process.exit(1)
  })
}
