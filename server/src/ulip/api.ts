// ULIP read API (Hono sub-app, mounted at /api/ulip). Every handler goes through
// the repository layer — no raw SQL here. Publicly viewable (no auth).
// Excel exports are generated on demand.
import { Hono } from 'hono'
import * as fundsRepo from '../repositories/funds'
import * as fundReturnsRepo from '../repositories/fundReturns'
import * as fundAllocationsRepo from '../repositories/fundAllocations'
import * as fundHoldingsRepo from '../repositories/fundHoldings'
import * as sourcesRepo from '../repositories/sources'
import * as views from '../repositories/ulipViews'
import { freshness } from './freshness'
import { buildFundHistory } from './history'
import { answerUlipChat } from './chat'
import { runInsurerMonth } from './pipeline'
import { identify, ingestUpload, reExtractStored } from './upload'
import { localExtractionAvailable, hasLocalExtractor } from './extract-local'
import { ADAPTERS } from './adapters'
import { buildCompanyWorkbook, buildSectionWorkbook, buildComparativeWorkbook, buildConsolidatedWorkbook } from './excel'
import { resolveFundSource, isServablePdf, pickSource, rawCandidates } from './sourcelinks'
import { RAW_DIR } from './config'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, resolve as resolvePathAbs, relative, isAbsolute } from 'node:path'
import { userFromAuthHeader, emailTrusted } from '../auth'
import type { Context } from 'hono'
import type { ChatMsg } from '../llm'

const ATTRIBUTION = 'Data sourced from insurer public ULIP fact-sheets'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Previous calendar month (YYYY-MM) — the default when no month is stored/requested,
 *  instead of a hardcoded stale month (M-U9). */
function defaultMonth(): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function resolveMonth(c: Context): Promise<string> {
  return c.req.query('month') || (await fundsRepo.latestMonth()) || defaultMonth()
}

// ——— Owner gate for the paid-LLM / mutating endpoints (POST /refresh, POST /chat) ———
// These trigger Gemini/Groq extraction + overwrite data, so they must not be public
// cost-abuse surfaces (H-5). Mirrors the guidance owner check: a verified Supabase JWT
// whose email is in GUIDANCE_OWNER_EMAILS. If no owner list is configured, auth is
// effectively disabled (local/dev) and access is allowed — same posture as guidance's
// DEV_OPEN, so we don't break single-user local runs.
function ownerEmails(): string[] {
  return (process.env.GUIDANCE_OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

async function isOwner(c: Context): Promise<boolean> {
  if (process.env.GUIDANCE_DEV_OPEN === 'true' && process.env.NODE_ENV !== 'production') return true // DEV ONLY
  const emails = ownerEmails()
  if (emails.length === 0) {
    // Unconfigured means "single-user local run" — convenient, and safe on a laptop.
    // In production it would mean the opposite: these routes overwrite stored data and
    // spend LLM credit, so an empty allow-list must DENY rather than admit the internet.
    // A deployment that forgets GUIDANCE_OWNER_EMAILS gets a locked door, not an open one.
    if (process.env.NODE_ENV === 'production') {
      console.warn('[ulip] admin route refused: GUIDANCE_OWNER_EMAILS is not set, so no account can be an admin')
      return false
    }
    return true
  }
  const user = await userFromAuthHeader(c.req.header('Authorization'))
  // M-S1: only trust the email claim when Supabase confirmed it.
  return emailTrusted(user) && emails.includes(user.email.toLowerCase())
}

function leanFund(f: Awaited<ReturnType<typeof fundsRepo.getBySfinMonth>>) {
  if (!f) return null
  return {
    sfin: f.sfin, month: f.month, insurer: f.insurer, name: f.name, class: f.class, category: f.category,
    nav: f.nav, inception: f.inception, benchmark: f.benchmark, manager: f.manager,
    ytm: f.ytm, modifiedDuration: f.modifiedDuration, managedSummary: f.managedSummary,
    aumTotal: f.aumTotal, aumUnit: f.aumUnit, aumTotalCr: f.aumTotalCr,
    aumEquityCr: f.aumEquityCr, aumDebtCr: f.aumDebtCr, aumMmiCr: f.aumMmiCr,
    status: f.status, confidence: f.confidence, flags: f.flags, coverage: f.coverage,
  }
}

export const ulipApi = new Hono()

// Insurers + freshness/QA, plus available months.
ulipApi.get('/insurers', async (c) => {
  const [fresh, months, primary] = await Promise.all([freshness(), fundsRepo.distinctMonths(), fundsRepo.primaryMonth()])
  // latestMonth = true newest (any coverage); defaultMonth = the picker's sensible default
  // (latest broadly-covered month) so it doesn't open on a 1-insurer leading edge.
  return c.json({ source: 'live', attribution: ATTRIBUTION, latestMonth: months[0] ?? null, defaultMonth: primary ?? months[0] ?? null, months, insurers: fresh })
})

ulipApi.get('/months', async (c) => c.json({ months: await fundsRepo.distinctMonths() }))

ulipApi.get('/categories', async (c) => {
  const month = await resolveMonth(c)
  return c.json({ month, categories: await fundsRepo.distinctCategories(month) })
})

// Funds list (per insurer, optional category) — visible (clean + unverified) only.
// `best=1` (browse view): return each insurer's LATEST available month ≤ the requested
// month, so an insurer whose data lags (e.g. ICICI ends May while July is picked) still
// shows its newest funds instead of an empty list. Each fund carries its own `month`.
ulipApi.get('/funds', async (c) => {
  const requested = await resolveMonth(c)
  const insurer = c.req.query('insurer')
  const category = c.req.query('category')
  const best = c.req.query('best') === '1'

  if (insurer) {
    // Selecting a specific insurer: show its data at the requested month, or fall back to
    // its latest available month (≤ requested, else its newest) rather than nothing.
    let month = requested
    let rows = await fundsRepo.listVisible(insurer, requested)
    if (rows.length === 0) {
      const alt = (await fundsRepo.latestMonthForInsurer(insurer, requested)) ?? (await fundsRepo.latestMonthForInsurer(insurer))
      if (alt) { month = alt; rows = await fundsRepo.listVisible(insurer, alt) }
    }
    if (category) rows = rows.filter((f) => f.category === category)
    return c.json({ month, requestedMonth: requested, attribution: ATTRIBUTION, funds: rows.map(leanFund) })
  }

  let rows = best ? await fundsRepo.listVisibleBestPerInsurer(requested) : await fundsRepo.listVisibleAllMonth(requested)
  if (category) rows = rows.filter((f) => f.category === category)
  return c.json({ month: requested, requestedMonth: requested, attribution: ATTRIBUTION, funds: rows.map(leanFund) })
})

// Single fund detail: header + returns + allocations + holdings + source links.
ulipApi.get('/fund/:sfin', async (c) => {
  const month = await resolveMonth(c)
  const sfin = c.req.param('sfin')
  const fund = await fundsRepo.getBySfinMonth(sfin, month)
  if (!fund) return c.json({ error: 'fund not found for month' }, 404)
  const [returns, allocations, holdings, srcs] = await Promise.all([
    fundReturnsRepo.getForFund(sfin, month),
    fundAllocationsRepo.getForFund(sfin, month),
    fundHoldingsRepo.getForFund(sfin, month),
    sourcesRepo.listByInsurerMonth(fund.insurer, month),
  ])
  return c.json({
    month,
    attribution: ATTRIBUTION,
    fund: leanFund(fund),
    returns,
    allocations: {
      asset: allocations.filter((a) => a.kind === 'asset'),
      sector: allocations.filter((a) => a.kind === 'sector'),
      fnu: allocations.filter((a) => a.kind === 'fnu'),
      rating: allocations.filter((a) => a.kind === 'rating'),
      maturity: allocations.filter((a) => a.kind === 'maturity'),
    },
    holdings,
    sources: srcs.map((s) => ({ kind: s.kind, url: s.url, rawPath: s.rawPath, fetchedAt: s.fetchedAt, parseStatus: s.parseStatus })),
    // Resolved per-fund source link: the exact PDF (deep-linked to this fund's page) or
    // a live webpage fallback. Drives the "source factsheet" link on the fund page.
    sourceLink: resolveFundSource({ sfin: fund.sfin, insurer: fund.insurer, name: fund.name, sourceKind: fund.sourceKind, sourcePage: fund.sourcePage }, month, srcs),
  })
})

// Stream the archived source PDF for a fund (public data). Resolves the fund → its
// backing source row → the file under RAW_DIR, and streams it inline so the browser's
// PDF viewer opens it (the frontend appends #page=N). If we hold no file, 302-redirect
// to the live insurer URL/fallback so the link never dead-ends.
ulipApi.get('/source/:sfin', async (c) => {
  const month = await resolveMonth(c)
  const sfin = c.req.param('sfin')
  const fund = await fundsRepo.getBySfinMonth(sfin, month)
  if (!fund) return c.json({ error: 'fund not found for month' }, 404)
  const srcs = await sourcesRepo.listByInsurerMonth(fund.insurer, month)
  const src = pickSource({ sfin: fund.sfin, insurer: fund.insurer, name: fund.name, sourceKind: fund.sourceKind }, srcs)

  if (isServablePdf(src)) {
    // Resolve the file safely under RAW_DIR. Path-traversal guard uses path.relative — a bare
    // startsWith(rawRoot) lets a SIBLING dir like `<root>-x` slip through; relative() + the
    // '..'/absolute test rejects anything that escapes the root (M-U2).
    const rawRoot = resolvePathAbs(RAW_DIR)
    for (const p of rawCandidates(src!.rawPath)) {
      const abs = resolvePathAbs(p)
      const rel = relative(rawRoot, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      if (!existsSync(abs)) continue
      try {
        // Stream the file instead of buffering the whole PDF into memory per request
        // (factsheets are multi-MB and this endpoint is public).
        const stat = statSync(abs)
        c.header('Content-Type', 'application/pdf')
        c.header('Content-Disposition', `inline; filename="${basename(abs)}"`)
        c.header('Cache-Control', 'public, max-age=86400')
        c.header('Content-Length', String(stat.size))
        return c.body(Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream)
      } catch { /* try next candidate */ }
    }
  }
  // No servable file → send them to the live source (fund page URL or insurer fallback).
  const link = resolveFundSource({ sfin: fund.sfin, insurer: fund.insurer, name: fund.name, sourceKind: fund.sourceKind, sourcePage: fund.sourcePage }, month, srcs)
  if (link.type === 'web' && link.href) return c.redirect(link.href, 302)
  return c.json({ error: 'no source available' }, 404)
})

// Fund history (time-series across every stored month) — powers the Trends tab.
// Only real stored months are returned (no synthetic preview).
ulipApi.get('/fund/:sfin/history', async (c) => {
  const sfin = c.req.param('sfin')
  const history = await buildFundHistory(sfin)
  if (!history) return c.json({ error: 'fund not found' }, 404)
  return c.json({ attribution: ATTRIBUTION, ...history })
})

// Month-over-month: holdings added / trimmed / bought / sold vs prior month.
ulipApi.get('/fund/:sfin/mom', async (c) => {
  const month = await resolveMonth(c)
  const sfin = c.req.param('sfin')
  const mom = await views.fundMoM(sfin, month)
  return c.json({ attribution: ATTRIBUTION, ...mom })
})

// Compare a set of funds side by side.
ulipApi.get('/compare', async (c) => {
  const month = await resolveMonth(c)
  const sfins = (c.req.query('sfins') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
  const funds = []
  for (const sfin of sfins) {
    const fund = await fundsRepo.getBySfinMonth(sfin, month)
    if (!fund) continue
    const [returns, allocations] = await Promise.all([
      fundReturnsRepo.getForFund(sfin, month),
      fundAllocationsRepo.getForFund(sfin, month),
    ])
    funds.push({ fund: leanFund(fund), returns, allocations: allocations.filter((a) => a.kind === 'asset') })
  }
  return c.json({ month, attribution: ATTRIBUTION, funds })
})

// Consolidated picker list + flagship cross-insurer holders for a symbol.
ulipApi.get('/consolidated/symbols', async (c) => {
  const month = await resolveMonth(c)
  return c.json({ month, symbols: await views.heldSymbols(month) })
})

ulipApi.get('/consolidated', async (c) => {
  const month = await resolveMonth(c)
  const symbol = c.req.query('symbol')
  if (!symbol) return c.json({ error: 'symbol required' }, 400)
  const holders = await views.consolidatedHolders(symbol.toUpperCase(), month)
  return c.json({ month, symbol: symbol.toUpperCase(), attribution: ATTRIBUTION, holders })
})

// Quarantine / QA review queue.
ulipApi.get('/quarantine', async (c) => {
  const month = await resolveMonth(c)
  const rows = await fundsRepo.listQuarantined(month)
  return c.json({ month, funds: rows.map((f) => ({ sfin: f.sfin, insurer: f.insurer, name: f.name, confidence: f.confidence, flags: f.flags })) })
})

// ——— Fetch-new-data: run the pipeline for one insurer from the UI (fire-and-forget) ———
const idByCode = new Map(Object.values(ADAPTERS).map((a) => [a.irdaiCode, a.id]))
interface RefreshState {
  status: 'running' | 'done' | 'error'
  insurer: string
  month: string
  startedAt: string
  finishedAt?: string
  stored?: number
  message?: string
}
let currentRefresh: RefreshState | null = null

ulipApi.post('/refresh', async (c) => {
  if (!(await isOwner(c))) return c.json({ error: 'not authorized' }, 401)
  if (currentRefresh?.status === 'running') return c.json({ error: 'a refresh is already running', current: currentRefresh }, 409)
  // Claim the single-flight slot SYNCHRONOUSLY, before any await, to close the TOCTOU race
  // (two near-simultaneous POSTs both passing the check → two interleaved pipelines) (H-6).
  const job: RefreshState = { status: 'running', insurer: '', month: '', startedAt: new Date().toISOString() }
  currentRefresh = job
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const code = String(body.insurer ?? '')
    const id = idByCode.get(code)
    if (!id) { currentRefresh = null; return c.json({ error: `unknown insurer code ${code}` }, 400) }
    const month = typeof body.month === 'string' && body.month ? body.month : await resolveMonth(c)
    job.insurer = code
    job.month = month
    // Fire-and-forget: archive -> extract (Gemini) -> validate -> store. Long-running but
    // fully async, so the API stays responsive; the UI polls /refresh/status.
    runInsurerMonth(id, month, { force: true })
      .then((s) => { job.status = 'done'; job.finishedAt = new Date().toISOString(); job.stored = s.stored; job.message = `stored ${s.stored} funds` })
      .catch((e) => { job.status = 'error'; job.finishedAt = new Date().toISOString(); job.message = (e as Error).message })
    return c.json({ started: true, insurer: code, month })
  } catch (e) {
    currentRefresh = null // release the slot on any pre-dispatch failure
    return c.json({ error: (e as Error).message }, 400)
  }
})

ulipApi.get('/refresh/status', (c) => c.json({ current: currentRefresh }))

// ——— Manual factsheet upload (admin only) ———
// Automated fetching breaks often — insurers rotate URLs, sit behind WAFs that block a
// server, or publish nothing discoverable. Uploading the PDF by hand is the always-works
// path, and it runs the SAME extract → validate → store pipeline as an automated fetch,
// so the resulting month is identical in every respect.

/** Whether the caller may use the admin tools, and whether the offline extractor is
 *  usable on this deployment. Drives visibility of the upload panel. */
ulipApi.get('/admin/status', async (c) => {
  const admin = await isOwner(c)
  if (!admin) return c.json({ admin: false })
  return c.json({
    admin: true,
    deterministicExtractor: await localExtractionAvailable(),
    insurers: Object.values(ADAPTERS).map((a) => ({
      id: a.id, code: a.irdaiCode, name: a.name, format: a.format,
      hasExtractor: hasLocalExtractor(a.id),
    })),
  })
})

/** Max upload size. Combined factsheets run ~2-15 MB; 64 MB is far above any real
 *  document while still bounding what a single request can buffer. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** Pull the uploaded file out of a multipart body, with a clear error for each way it
 *  can be wrong (no file, wrong field, too big). */
async function readUpload(c: Context): Promise<{ buf: Buffer; name: string } | { error: string; status: 400 | 413 }> {
  let body: Record<string, unknown>
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>
  } catch {
    return { error: 'Could not read the upload — send it as multipart/form-data with the PDF in a "file" field.', status: 400 }
  }
  const file = body.file
  if (!(file instanceof File)) {
    return { error: 'No file received. Attach the factsheet PDF in a "file" field.', status: 400 }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, status: 413 }
  }
  if (file.size === 0) return { error: 'The uploaded file is empty.', status: 400 }
  return { buf: Buffer.from(await file.arrayBuffer()), name: file.name || 'upload.pdf' }
}

/** Dry run: report which insurer + month the document declares, storing nothing.
 *  The panel calls this on file-select so the operator confirms before committing. */
ulipApi.post('/identify', async (c) => {
  if (!(await isOwner(c))) return c.json({ error: 'not authorized' }, 401)
  const up = await readUpload(c)
  if ('error' in up) return c.json({ error: up.error }, up.status)
  if (!up.buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    return c.json({
      insurerId: null, insurerName: null, month: null,
      evidence: [`file does not start with %PDF (got "${up.buf.subarray(0, 16).toString('latin1').replace(/\s+/g, ' ')}")`],
    })
  }
  return c.json(identify(up.buf))
})

ulipApi.post('/upload', async (c) => {
  if (!(await isOwner(c))) return c.json({ error: 'not authorized' }, 401)
  const up = await readUpload(c)
  if ('error' in up) return c.json({ error: up.error }, up.status)
  const q = c.req.query()
  try {
    const res = await ingestUpload(up.buf, up.name, {
      insurerId: q.insurer || undefined,
      month: q.month || undefined,
      force: q.force === '1' || q.force === 'true',
    })
    return c.json(res, res.ok ? 200 : 422)
  } catch (e) {
    return c.json({ ok: false, message: `Upload failed: ${(e as Error).message}` }, 500)
  }
})

/** Re-parse a month that is already archived — for when the extractor improved but the
 *  stored data came from an older/worse parse. No download, no upload. */
ulipApi.post('/re-extract', async (c) => {
  if (!(await isOwner(c))) return c.json({ error: 'not authorized' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const insurerCode = String(body.insurer ?? '')
  const id = idByCode.get(insurerCode) ?? (ADAPTERS[insurerCode] ? insurerCode : undefined)
  if (!id) return c.json({ error: `unknown insurer ${insurerCode}` }, 400)
  const month = typeof body.month === 'string' && body.month ? body.month : await resolveMonth(c)
  try {
    const res = await reExtractStored(id, month)
    return c.json(res, res.ok ? 200 : 422)
  } catch (e) {
    return c.json({ ok: false, message: `Re-extract failed: ${(e as Error).message}` }, 500)
  }
})

// Insurance Monitor chat — grounded in the factsheet data, optional web-dive.
// Public feature, but it calls paid LLMs — protected by a rate limiter mounted in
// index.ts (app.use('/api/ulip/chat', chatRateLimiter)), NOT an owner gate (H-5).
ulipApi.post('/chat', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const messages: ChatMsg[] = Array.isArray(body.messages)
    ? (body.messages as ChatMsg[])
    : body.question
      ? [{ role: 'user', content: String(body.question) }]
      : []
  if (messages.length === 0) return c.json({ error: 'question or messages required' }, 400)
  const month = typeof body.month === 'string' ? body.month : undefined
  const res = await answerUlipChat(messages, { month, webDive: Boolean(body.webDive) })
  if (!res) return c.json({ error: 'AI desk unavailable' }, 503)
  return c.json(res)
})

// ——— Excel exports (on demand) ———
function sendXlsx(c: Context, out: { buffer: Buffer; filename: string }) {
  c.header('Content-Type', XLSX_MIME)
  c.header('Content-Disposition', `attachment; filename="${out.filename}"`)
  // Hono's c.body wants an ArrayBuffer/stream/string — hand it the exact bytes.
  const ab = out.buffer.buffer.slice(out.buffer.byteOffset, out.buffer.byteOffset + out.buffer.byteLength) as ArrayBuffer
  return c.body(ab)
}

ulipApi.get('/export/company', async (c) => {
  const month = await resolveMonth(c)
  const insurer = c.req.query('insurer')
  if (!insurer) return c.json({ error: 'insurer required' }, 400)
  return sendXlsx(c, await buildCompanyWorkbook(insurer, month))
})

ulipApi.get('/export/section', async (c) => {
  const month = await resolveMonth(c)
  const category = c.req.query('category')
  if (!category) return c.json({ error: 'category required' }, 400)
  return sendXlsx(c, await buildSectionWorkbook(category, month))
})

ulipApi.get('/export/comparative', async (c) => {
  const month = await resolveMonth(c)
  // Cap the fund count (like /compare) so a huge sfins list can't fan out into an unbounded workbook.
  const sfins = (c.req.query('sfins') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)
  if (sfins.length === 0) return c.json({ error: 'sfins required' }, 400)
  return sendXlsx(c, await buildComparativeWorkbook(sfins, month))
})

ulipApi.get('/export/consolidated', async (c) => {
  const month = await resolveMonth(c)
  return sendXlsx(c, await buildConsolidatedWorkbook(month))
})
