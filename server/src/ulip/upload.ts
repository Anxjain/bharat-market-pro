// Manual factsheet upload — the reliable way to get a month in when automated fetching
// fails, which it regularly does: insurers rotate URLs without notice, put the document
// behind a WAF that 403s a server (Canara), or publish nothing a crawler can find.
//
// The uploader supplies only the PDF. Which insurer it belongs to and which month it
// reports are both read OUT OF THE DOCUMENT, never trusted from the form — a mislabelled
// upload would otherwise write one insurer's holdings under another's month permanently.
//
// Flow: verify it's a real PDF -> identify insurer (SFIN codes) + month (as-on date) ->
// archive under the normal raw/ layout -> deterministic extraction -> validate -> store.
// From there it is indistinguishable from an automatically fetched month.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADAPTERS, getAdapter, type UlipAdapter } from './adapters'
import { RAW_DIR } from './config'
import { extract } from './extract'
import { store } from './store'
import { buildAliasesFromInstruments, seedManualAliases } from './seed'
import { inferMonth } from './discovery'
import * as insurersRepo from '../repositories/insurers'
import * as sourcesRepo from '../repositories/sources'

/** Read a PDF's text layer. Empty string when poppler is missing or the file is unreadable.
 *  Pass no page range to read the WHOLE document — identification votes across every page,
 *  because insurers bury the SFIN index and the as-on date at unpredictable depths. */
function pdfText(file: string, firstPage?: number, lastPage?: number): string {
  const range = firstPage && lastPage ? ['-f', String(firstPage), '-l', String(lastPage)] : []
  try {
    return execFileSync(
      'pdftotext',
      [...range, '-layout', '-enc', 'UTF-8', file, '-'],
      { maxBuffer: 128 * 1024 * 1024 },
    ).toString('utf8')
  } catch {
    return ''
  }
}

export interface Identity {
  insurerId: string | null
  insurerName: string | null
  month: string | null
  /** How the insurer was decided, for display in the upload panel. */
  evidence: string[]
}

/**
 * Identify the insurer from the SFIN codes printed on the document.
 *
 * Every IRDAI-registered ULIP fund carries an SFIN whose LAST THREE DIGITS are the
 * insurer's IRDAI code (HDFC 101, Kotak 107, …). That makes identification exact rather
 * than a guess from filenames or branding: we count the codes seen and take the majority,
 * so a stray cross-reference to another insurer can't flip the result.
 */
export function detectInsurer(text: string): { id: string | null; counts: Record<string, number> } {
  const counts: Record<string, number> = {}
  const bump = (code: string) => { counts[code] = (counts[code] ?? 0) + 1 }

  // SFIN = ULIF/ULGF + fund no + date + mnemonic + 3-digit insurer code, and the insurer
  // code is always the token's LAST THREE CHARACTERS. Matching the whole token and taking
  // its tail is the only reliable read: a mid-token match lands on the wrong digits when
  // the mnemonic itself ends in one (Bandhan prints "…EEF0138" — tail 138, not 013).
  //
  // Two printed forms, both real: contiguous (HDFC "ULIF05110/03/11DiscontdPF101") and
  // space/hyphen separated (Tata "ULIF 060 15/07/14 MCF 110"). Matching the contiguous
  // form on the ORIGINAL text — never on a whitespace-stripped copy — is what keeps a
  // trailing page number from being glued onto the SFIN and read as the insurer code.
  for (const m of text.matchAll(/UL[IG]F[A-Za-z0-9/]{8,40}/g)) {
    const tail = m[0].slice(-3)
    if (/^\d{3}$/.test(tail)) bump(tail)
  }
  for (const m of text.matchAll(/UL[IG]F[ -]\d{3}[ -][\d/]{6,10}[ -][A-Za-z0-9]{2,20}[ -](\d{3})(?![A-Za-z0-9])/g)) {
    bump(m[1])
  }
  const byCode = new Map(Object.values(ADAPTERS).map((a) => [a.irdaiCode, a.id]))
  let best: string | null = null
  let bestN = 0
  for (const [code, n] of Object.entries(counts)) {
    const id = byCode.get(code)
    if (id && n > bestN) { best = id; bestN = n }
  }
  if (best) return { id: best, counts }

  // Fallback: brand name. Some sheets print SFINs that are truncated in the text layer
  // (ICICI Prudential's performance PDF carries 145 of them, all cut off before the
  // insurer code), leaving nothing to count. The brand is still on every page, so match
  // it — but only when the exact route found nothing, since a name can also appear as a
  // benchmark or a holding ("HDFC Bank Limited" sits in most equity portfolios).
  const hay = text.toLowerCase()
  let nameBest: string | null = null
  let nameN = 0
  for (const a of Object.values(ADAPTERS)) {
    // First token of the brand ("ICICI Prudential Life" -> "icici"), which survives the
    // house style each insurer uses for itself ("ICICI Pru", "ICICI Prudential").
    const brand = a.name.toLowerCase().split(/\s+/)[0]
    if (!brand || brand.length < 3) continue
    const n = hay.split(brand).length - 1
    if (n > nameN) { nameBest = a.id; nameN = n }
  }
  return { id: nameBest, counts }
}

/**
 * The month the document reports ("as on 29 May 2026" -> 2026-05).
 *
 * Decided by MAJORITY VOTE across every page, not by the first match. A combined
 * factsheet repeats its as-on date on each fund page, but the cover/market-commentary
 * pages are often dated the following month (the month it was published, not reported) —
 * taking the first hit picks up that publication date and files the whole month wrong.
 * The winning date appears once per fund, so counting is decisive.
 */
export function detectMonth(text: string): string | null {
  const votes = new Map<string, number>()
  const bump = (m: string | null) => { if (m) votes.set(m, (votes.get(m) ?? 0) + 1) }

  const asOn = /as\s+(?:on|at|of|per)[^\n]{0,40}?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ,]?\s?\d{1,4}(?:,?\s?20\d{2})?|20\d{2}[-/ ]\d{1,2})/gi
  for (const m of text.matchAll(asOn)) bump(inferMonth(m[1]))

  // Sheets that never say "as on" and just stamp the date on each fund page. All three
  // printed orders occur: "May 31, 2026", "31 May 2026", "June 2026".
  if (votes.size === 0) {
    const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december)'
    const banner = new RegExp(
      `\\b(${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*20\\d{2}` + // May 31, 2026
      `|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s*,?\\s*20\\d{2}` + // 31 May 2026
      `|${MONTH}\\s*,?\\s*20\\d{2})\\b`,                          // June 2026
      'gi',
    )
    for (const m of text.matchAll(banner)) bump(inferMonth(m[1]))
  }

  if (votes.size === 0) return null
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0][0]
}

/** Inspect an uploaded PDF without storing anything — powers the upload panel's preview. */
export function identify(buf: Buffer): Identity {
  const tmp = join(RAW_DIR, `.identify-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`)
  mkdirSync(RAW_DIR, { recursive: true })
  writeFileSync(tmp, buf)
  try {
    // Whole document: SFIN indexes and as-on dates sit at unpredictable depths, and both
    // detections vote across all occurrences rather than trusting the first hit.
    const text = pdfText(tmp)
    const { id, counts } = detectInsurer(text)
    const month = detectMonth(text)
    const evidence: string[] = []
    if (id && counts[getAdapter(id).irdaiCode]) {
      const a = getAdapter(id)
      evidence.push(`SFIN insurer code ${a.irdaiCode} seen ${counts[a.irdaiCode]} time(s)`)
    } else if (id) {
      evidence.push(`no usable SFIN codes — identified from the brand name on the document`)
    } else if (Object.keys(counts).length) {
      evidence.push(`SFIN codes found (${Object.keys(counts).join(', ')}) match no configured insurer`)
    } else {
      evidence.push('no SFIN codes or recognisable insurer name found')
    }
    evidence.push(month ? `reporting month read as ${month}` : 'no "as on <date>" found')
    return {
      insurerId: id,
      insurerName: id ? getAdapter(id).name : null,
      month,
      evidence,
    }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
  }
}

export interface UploadResult {
  ok: boolean
  insurer: string | null
  insurerName: string | null
  month: string | null
  /** How the funds were parsed: deterministic extractor, LLM fallback, or nothing. */
  via: string
  stored: number
  byStatus: { clean: number; suspicious: number; failed: number }
  holdings: number
  replaced: boolean
  message: string
  evidence: string[]
}

export interface UploadOptions {
  /** Override auto-detection. Only honoured when the document has no SFIN evidence of
   *  its own, or when the caller explicitly confirms a mismatch with `force`. */
  insurerId?: string
  month?: string
  /** Re-ingest even when this insurer-month is already stored. */
  force?: boolean
}

/**
 * Ingest an uploaded factsheet end to end.
 *
 * `originalName` is used only for per-fund insurers (Tata publishes one PDF per fund, so
 * the filename is what keeps them apart inside the month's folder). For everyone else the
 * archive name is derived from the adapter, exactly as an automated fetch would name it.
 */
export async function ingestUpload(buf: Buffer, originalName: string, opts: UploadOptions = {}): Promise<UploadResult> {
  const fail = (message: string, extra: Partial<UploadResult> = {}): UploadResult => ({
    ok: false, insurer: null, insurerName: null, month: null, via: 'none',
    stored: 0, byStatus: { clean: 0, suspicious: 0, failed: 0 }, holdings: 0,
    replaced: false, message, evidence: [], ...extra,
  })

  // A WAF challenge page saved with a .pdf extension is the single most common bad
  // upload (it is how Canara's month ended up unparseable), so reject on the magic
  // bytes rather than the filename.
  if (!buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    const head = buf.subarray(0, 24).toString('latin1').replace(/\s+/g, ' ')
    return fail(`That file isn't a PDF — it starts "${head}". If you saved it from the insurer's site, open the link in a browser and use Print → Save as PDF, or download the document directly.`)
  }

  const ident = identify(buf)
  const insurerId = opts.insurerId || ident.insurerId
  if (!insurerId) {
    return fail(
      'Could not tell which insurer this factsheet belongs to — no fund SFIN codes were found in its first pages. Pick the insurer explicitly and upload again.',
      { evidence: ident.evidence },
    )
  }
  if (!ADAPTERS[insurerId]) return fail(`Unknown insurer "${insurerId}".`, { evidence: ident.evidence })

  // A chosen insurer that contradicts the document's own SFINs is almost always a
  // mis-selection. Refuse unless the caller explicitly forces it, because storing it
  // would attribute one insurer's holdings to another.
  if (opts.insurerId && ident.insurerId && ident.insurerId !== opts.insurerId && !opts.force) {
    return fail(
      `You selected ${getAdapter(opts.insurerId).name}, but the document's SFIN codes say it is ${getAdapter(ident.insurerId).name}. Re-upload with the right insurer, or confirm to override.`,
      { evidence: ident.evidence },
    )
  }

  const month = opts.month || ident.month
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return fail(
      'Could not read the reporting month from this document (no "as on <date>" line). Choose the month explicitly and upload again.',
      { evidence: ident.evidence },
    )
  }
  // Same reasoning as the insurer check: a stated month that disagrees with the printed
  // as-on date is how duplicate/wrong-month data gets frozen into the archive.
  if (opts.month && ident.month && ident.month !== opts.month && !opts.force) {
    return fail(
      `You selected ${opts.month}, but the document reports ${ident.month}. Re-upload with the right month, or confirm to override.`,
      { evidence: ident.evidence },
    )
  }

  const adapter: UlipAdapter = getAdapter(insurerId)

  await insurersRepo.upsert({
    irdaiCode: adapter.irdaiCode,
    name: adapter.name,
    website: adapter.website,
    adapterId: adapter.id,
    status: 'active',
  })
  await buildAliasesFromInstruments()
  await seedManualAliases()

  // Name + place the file the way an automated fetch would, so downstream source links,
  // page detection and idempotency all behave identically.
  const perFund = adapter.format === 'per-fund-pdf'
  const docs = adapter.docs(month)
  const safeName = originalName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'upload.pdf'
  const filename = perFund
    ? (safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`)
    : (docs[0]?.filename ?? `${adapter.id}-${month}.pdf`)
  const kind = perFund ? `fund:${filename.replace(/\.pdf$/i, '')}` : (docs[0]?.kind ?? 'combined')

  const dir = join(RAW_DIR, adapter.id, month)
  mkdirSync(dir, { recursive: true })
  const rawPath = join(dir, filename)

  const existing = await sourcesRepo.get(adapter.irdaiCode, month, kind)
  const replaced = Boolean(existing) || existsSync(rawPath)
  const sha = createHash('sha256').update(buf).digest('hex')
  if (existing?.sha256 === sha && !opts.force) {
    return fail(
      `This exact document is already stored for ${adapter.name} ${month} (identical checksum). Use "replace" if you want to re-extract it anyway.`,
      { insurer: adapter.irdaiCode, insurerName: adapter.name, month, evidence: ident.evidence },
    )
  }

  writeFileSync(rawPath, buf)
  await sourcesRepo.upsert({
    insurer: adapter.irdaiCode,
    month,
    kind,
    rawPath,
    url: null, // manually supplied — there is no fetched URL to record
    sha256: sha,
    fetchedAt: new Date().toISOString(),
    parseStatus: 'archived',
  })

  // ULIP_NO_CACHE for this call only: an upload is an explicit "parse THIS file" request,
  // so a stale cache entry from a previous attempt must not short-circuit it.
  const prevNoCache = process.env.ULIP_NO_CACHE
  process.env.ULIP_NO_CACHE = '1'
  let ex: Awaited<ReturnType<typeof extract>>
  try {
    ex = await extract(adapter.id, kind, rawPath, month)
  } finally {
    if (prevNoCache === undefined) delete process.env.ULIP_NO_CACHE
    else process.env.ULIP_NO_CACHE = prevNoCache
  }

  if (ex.funds.length === 0) {
    await sourcesRepo.upsert({
      insurer: adapter.irdaiCode, month, kind, rawPath, url: null, sha256: sha,
      fetchedAt: new Date().toISOString(), parseStatus: 'parse_failed',
    })
    return fail(
      `The PDF was stored but no funds could be parsed from it${ex.localReason ? ` — ${ex.localReason}` : ''}. The file is kept in the archive, so a fix to the extractor can re-run over it.`,
      { insurer: adapter.irdaiCode, insurerName: adapter.name, month, via: ex.via, replaced, evidence: ident.evidence },
    )
  }

  const res = await store(adapter, month, ex.funds)
  await sourcesRepo.upsert({
    insurer: adapter.irdaiCode, month, kind, rawPath, url: null, sha256: sha,
    fetchedAt: new Date().toISOString(), parseStatus: 'stored',
  })

  const holdings = ex.funds.reduce((n, f) => n + (f.holdings?.length ?? 0), 0)
  return {
    ok: true,
    insurer: adapter.irdaiCode,
    insurerName: adapter.name,
    month,
    via: ex.via,
    stored: res.stored,
    byStatus: res.byStatus,
    holdings,
    replaced,
    message:
      `${adapter.name} ${month}: stored ${res.stored} fund${res.stored === 1 ? '' : 's'} ` +
      `(${res.byStatus.clean} clean, ${res.byStatus.suspicious} flagged) with ${holdings} holdings, ` +
      `parsed by ${ex.via === 'local' ? 'the deterministic extractor' : ex.via}.`,
    evidence: ident.evidence,
  }
}

/** Re-run extraction + store over an ALREADY-ARCHIVED month, without re-downloading.
 *  This is the "the parse was wrong, I fixed the extractor" button. */
export async function reExtractStored(insurerId: string, month: string): Promise<UploadResult> {
  const adapter = getAdapter(insurerId)
  const fail = (message: string): UploadResult => ({
    ok: false, insurer: adapter.irdaiCode, insurerName: adapter.name, month, via: 'none',
    stored: 0, byStatus: { clean: 0, suspicious: 0, failed: 0 }, holdings: 0,
    replaced: false, message, evidence: [],
  })

  const docs = adapter.docs(month)
  const kind = docs[0]?.kind ?? 'combined'
  const src = await sourcesRepo.get(adapter.irdaiCode, month, kind)
  const rawPath = src?.rawPath ?? join(RAW_DIR, adapter.id, month, docs[0]?.filename ?? `${adapter.id}-${month}.pdf`)
  if (!existsSync(rawPath)) {
    return fail(`No archived PDF for ${adapter.name} ${month}. Upload the factsheet first.`)
  }

  const prevNoCache = process.env.ULIP_NO_CACHE
  process.env.ULIP_NO_CACHE = '1'
  let ex: Awaited<ReturnType<typeof extract>>
  try {
    ex = await extract(adapter.id, kind, rawPath, month)
  } finally {
    if (prevNoCache === undefined) delete process.env.ULIP_NO_CACHE
    else process.env.ULIP_NO_CACHE = prevNoCache
  }
  if (ex.funds.length === 0) {
    return fail(`Re-extraction produced no funds${ex.localReason ? ` — ${ex.localReason}` : ''}.`)
  }

  const res = await store(adapter, month, ex.funds)
  const holdings = ex.funds.reduce((n, f) => n + (f.holdings?.length ?? 0), 0)
  const buf = readFileSync(rawPath)
  await sourcesRepo.upsert({
    insurer: adapter.irdaiCode, month, kind, rawPath, url: src?.url ?? null,
    sha256: createHash('sha256').update(buf).digest('hex'),
    fetchedAt: new Date().toISOString(), parseStatus: 'stored',
  })
  return {
    ok: true, insurer: adapter.irdaiCode, insurerName: adapter.name, month, via: ex.via,
    stored: res.stored, byStatus: res.byStatus, holdings, replaced: true,
    message: `Re-extracted ${adapter.name} ${month}: ${res.stored} funds, ${holdings} holdings (via ${ex.via}).`,
    evidence: [`re-parsed the archived PDF at ${rawPath}`],
  }
}
