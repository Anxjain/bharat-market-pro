// RAW-FIRST archival: always save the original document to
//   raw/<insurer-id>/<YYYY-MM>/<file>
// and record a `sources` row BEFORE any parsing, so re-runs parse from disk
// without re-fetching.
//
// Acquisition order (each step best-effort):
//   1. discover the LATEST link (listing adapters scrape their page; never a
//      hard-coded drifting filename),
//   2. fetch via the adapter's mode — plain fetch + browser UA, or headless
//      Chromium for bot-protected/tokenised sites,
//   3. fall back to the bundled reference file in folder 2 (offline runs).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { RAW_DIR, REF_DIR, FACTSHEET_DIR, INTAKE_DIR } from './config'
import { fetchViaChromium, fetchHtmlViaChromium } from './browser'
import { inferMonth } from './discovery'
import * as sourcesRepo from '../repositories/sources'
import type { UlipAdapter, UlipDoc } from './adapters'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Detect a document's internal "as on <Month YYYY>" reporting month via a cheap pdftotext
 * pass over the first pages, returning YYYY-MM or null when it can't be determined (missing
 * poppler / no explicit as-on phrase). We only key off an explicit "as on/at/of <month>"
 * phrase — a bare date elsewhere (a fund inception, a footer) must not be mistaken for it.
 */
function detectPdfMonth(file: string): string | null {
  try {
    const txt = execFileSync(
      'pdftotext',
      ['-f', '1', '-l', '3', '-layout', '-enc', 'UTF-8', file, '-'],
      { maxBuffer: 32 * 1024 * 1024 },
    ).toString('utf8')
    // The month token may be "Jan 2026", "Jan-26" or a full date "Jan 23, 2026" — capture
    // any trailing 4-digit year so inferMonth can tell a day-of-month from a 2-digit year.
    const asOn = txt.match(
      /as\s+(?:on|at|of|per)[^\n]{0,40}?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ,]?\s?\d{1,4}(?:,?\s?20\d{2})?|20\d{2}[-/ ]\d{1,2})/i,
    )
    return asOn ? inferMonth(asOn[1]) : null
  } catch {
    return null // pdftotext unavailable / unreadable — can't verify, so don't block
  }
}

/** Filesystem-safe bank name: "Kotak Mahindra Life Insurance" -> "Kotak-Mahindra-Life-Insurance". */
function safeBank(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

interface ManifestEntry {
  bank: string
  irdaiCode: string
  month: string
  kind: string
  via: 'live' | 'reference'
  sourceUrl: string
  fetchedAt: string
  fetchedDate: string
  sha256: string
  sizeBytes: number
  file: string // friendly filename inside factsheets/
  rawPath: string
}

/**
 * Save a human-readable copy of the fetched PDF as
 *   factsheets/<Bank-Name>_<YYYY-MM>_<via>_fetched-<YYYY-MM-DD>.pdf
 * and append/replace its row in factsheets/manifest.json. This is the "download the
 * insurer's PDF and keep it, labelled by bank + date" library the user asked for.
 */
function saveFactsheetCopy(
  adapter: UlipAdapter,
  doc: UlipDoc,
  month: string,
  buf: Buffer,
  via: 'live' | 'reference',
  fetchedAt: string,
  hash: string,
): string {
  mkdirSync(FACTSHEET_DIR, { recursive: true })
  const fetchedDate = fetchedAt.slice(0, 10) // YYYY-MM-DD
  const kindTag = doc.kind === 'combined' ? '' : `_${doc.kind.replace(/[^A-Za-z0-9]+/g, '-')}`
  const file = `${safeBank(adapter.name)}_${month}${kindTag}_${via}_fetched-${fetchedDate}.pdf`
  writeFileSync(join(FACTSHEET_DIR, file), buf)

  const manifestPath = join(FACTSHEET_DIR, 'manifest.json')
  let manifest: ManifestEntry[] = []
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[]
    } catch {
      manifest = []
    }
  }
  const entry: ManifestEntry = {
    bank: adapter.name,
    irdaiCode: adapter.irdaiCode,
    month,
    kind: doc.kind,
    via,
    sourceUrl: doc.url,
    fetchedAt,
    fetchedDate,
    sha256: hash,
    sizeBytes: buf.length,
    file,
    rawPath: join(RAW_DIR, adapter.id, month, doc.filename),
  }
  // One row per (insurer, month, kind): replace any prior entry.
  manifest = manifest.filter((m) => !(m.irdaiCode === entry.irdaiCode && m.month === month && m.kind === doc.kind))
  manifest.push(entry)
  manifest.sort((a, b) => a.bank.localeCompare(b.bank) || a.month.localeCompare(b.month) || a.kind.localeCompare(b.kind))
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return file
}

export interface ArchivedDoc {
  doc: UlipDoc
  rawPath: string
  sha256: string
  via: 'live' | 'reference' | 'cache'
}

async function fetchListingHtml(adapter: UlipAdapter): Promise<string | null> {
  const url = adapter.listingUrl
  if (!url) return null
  if (adapter.fetchMode === 'chromium') return fetchHtmlViaChromium(url)
  try {
    const res = await fetch(url, { headers: adapter.fetchHeaders ?? {}, signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.text() : null
  } catch (e) {
    console.warn(`[ulip] ${adapter.id} listing fetch unavailable: ${(e as Error).message}`)
    return null
  }
}

/** Resolve the actual document URL: scrape the listing for listing-discovery adapters.
 *  Returns the REAL PDF url (not the listing page) so provenance + live deep-links are right. */
async function resolveUrl(adapter: UlipAdapter, doc: UlipDoc, month: string): Promise<string> {
  if (adapter.discovery === 'listing' && adapter.listingUrl && adapter.scrapeListing) {
    const html = await fetchListingHtml(adapter)
    if (html) {
      const links = adapter.scrapeListing(html, month)
      const match = links.find((l) => l.kind === doc.kind) ?? links[0]
      if (match) return match.url
    }
  }
  return doc.url
}

async function fetchDoc(adapter: UlipAdapter, url: string): Promise<Buffer | null> {
  if (adapter.fetchMode === 'chromium') {
    const r = await fetchViaChromium(url)
    return r ? r.buffer : null
  }
  // AUDIT FIX (2026-07-14): a single transient failure here (5xx / DNS / CDN hiccup) used
  // to lose an entire month with no recovery. Retry 4xx-except-429 once fast, real
  // transient errors up to 3 attempts with backoff. Permanent 4xx aren't retried.
  const BACKOFF_MS = [0, 2000, 5000]
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]))
    try {
      const res = await fetch(url, { headers: adapter.fetchHeaders ?? {}, signal: AbortSignal.timeout(30_000) })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      const transient = res.status >= 500 || res.status === 429
      console.warn(`[ulip] ${adapter.id} fetch HTTP ${res.status}${transient && attempt < BACKOFF_MS.length - 1 ? ' — retrying' : ''}`)
      if (!transient) return null // permanent client error — no point retrying
    } catch (e) {
      console.warn(`[ulip] ${adapter.id} fetch unavailable: ${(e as Error).message}${attempt < BACKOFF_MS.length - 1 ? ' — retrying' : ''}`)
    }
  }
  return null
}

export async function archive(
  adapter: UlipAdapter,
  month: string,
  doc: UlipDoc,
  opts: { force?: boolean } = {},
): Promise<ArchivedDoc | null> {
  const dir = join(RAW_DIR, adapter.id, month)
  const rawPath = join(dir, doc.filename)

  // Idempotent: if we already archived this doc and the file is on disk, reuse it —
  // UNLESS force, in which case we re-fetch and compare sha256 (H-10) so a mid-month
  // insurer re-upload is actually picked up rather than re-extracting stale cached bytes.
  const existing = await sourcesRepo.get(adapter.irdaiCode, month, doc.kind)
  if (!opts.force && existing && existsSync(rawPath)) {
    // Ensure the human-readable bank+date copy exists even on a cache hit (the raw
    // file may have been archived before the factsheets/ library existed).
    const friendlyExists = existsSync(FACTSHEET_DIR) &&
      readdirSync(FACTSHEET_DIR).some((f) => f.startsWith(`${safeBank(adapter.name)}_${month}`) && f.endsWith('.pdf'))
    if (!friendlyExists) {
      const via: 'reference' = 'reference'
      saveFactsheetCopy(adapter, doc, month, readFileSync(rawPath), via, existing.fetchedAt ?? new Date().toISOString(), existing.sha256)
    }
    return { doc, rawPath, sha256: existing.sha256, via: 'cache' }
  }

  mkdirSync(dir, { recursive: true })

  let buf: Buffer | null = null
  let via: 'live' | 'reference' = 'live'
  // The REAL resolved PDF url (refined by listing scrape), stored on the sources row so
  // provenance + live deep-link fallbacks point at the actual file, not the listing page (M-U4).
  let resolvedUrl = doc.url

  // 1) live: discover latest link + fetch via the adapter's mode. ULIP_SKIP_FETCH=1 forces offline.
  if (process.env.ULIP_SKIP_FETCH !== '1') {
    resolvedUrl = await resolveUrl(adapter, doc, month)
    buf = await fetchDoc(adapter, resolvedUrl)
  }

  // 2) fall back to the bundled reference factsheet in folder 2
  if (!buf && doc.refFile) {
    const ref = join(REF_DIR, doc.refFile)
    if (existsSync(ref)) {
      buf = readFileSync(ref)
      via = 'reference'
    }
  }

  // 3) manual intake: a PDF the user dropped in intake/ as <id>_<month>.pdf or
  //    <id>.pdf. Covers bot-protected/JS sites with no stable URL (ICICI Pru, Bandhan).
  if (!buf) {
    for (const name of [`${adapter.id}_${month}.pdf`, `${adapter.id}-${month}.pdf`, `${adapter.id}.pdf`]) {
      const intake = join(INTAKE_DIR, name)
      if (existsSync(intake)) {
        buf = readFileSync(intake)
        via = 'reference'
        console.log(`[ulip] ${adapter.id} ${doc.kind} ${month}: using manual intake file intake/${name}`)
        break
      }
    }
  }

  // On a forced re-fetch that failed (transient), fall back to the previously archived bytes
  // rather than dropping the month entirely.
  if (!buf && opts.force && existsSync(rawPath)) {
    buf = readFileSync(rawPath)
    via = 'reference'
    console.warn(`[ulip] ${adapter.id} ${doc.kind} ${month}: force re-fetch failed — reusing previously archived copy`)
  }

  if (!buf) {
    console.warn(
      `[ulip] ${adapter.id} ${doc.kind} ${month}: no live source, no reference, no intake file — gap. ` +
        `To ingest manually, drop the PDF at intake/${adapter.id}_${month}.pdf and re-run.`,
    )
    return null
  }

  // Reject non-PDF bytes outright. A listing-discovery miss can hand back the listing
  // PAGE itself (HTML saved as .pdf) — pdftotext then errors, the as-on guard silently
  // passes (null = "can't verify"), and garbage gets archived as a factsheet. This is
  // exactly how Shriram's nav-history page ended up stored as two months' factsheets.
  if (/\.pdf$/i.test(doc.filename) && !buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    console.error(`[ulip] ${adapter.id} ${doc.kind} ${month}: fetched bytes are not a PDF (starts "${buf.subarray(0, 12).toString('latin1').replace(/\s+/g, ' ')}") — refusing to archive.`)
    return null
  }

  // As-on month verification (H-7): write to a temp copy, detect the document's internal
  // reporting month, and HARD-FAIL on a confident mismatch — so a wrong-month document never
  // overwrites a correct archived one and never gets stored under the requested month.
  const tmpPath = `${rawPath}.incoming`
  writeFileSync(tmpPath, buf)
  const detected = detectPdfMonth(tmpPath)
  if (detected && detected !== month) {
    try { rmSync(tmpPath, { force: true }) } catch { /* best-effort */ }
    console.error(
      `[ulip] ${adapter.id} ${doc.kind} ${month}: AS-ON MONTH MISMATCH — document reports ${detected}, ` +
        `requested ${month}. Refusing to archive/store wrong-month data.`,
    )
    return null
  }

  const hash = sha256(buf)
  if (opts.force && existing) {
    console.log(
      existing.sha256 === hash
        ? `[ulip] ${adapter.id} ${doc.kind} ${month}: force re-fetch — bytes UNCHANGED (sha256 ${hash.slice(0, 12)})`
        : `[ulip] ${adapter.id} ${doc.kind} ${month}: force re-fetch — bytes CHANGED (${(existing.sha256 ?? '').slice(0, 12)} -> ${hash.slice(0, 12)})`,
    )
  }

  writeFileSync(rawPath, buf) // RAW-FIRST: persist the (verified) original before parsing
  try { rmSync(tmpPath, { force: true }) } catch { /* best-effort */ }
  const fetchedAt = new Date().toISOString()
  await sourcesRepo.upsert({
    insurer: adapter.irdaiCode,
    month,
    kind: doc.kind,
    rawPath,
    url: resolvedUrl,
    sha256: hash,
    fetchedAt,
    parseStatus: 'archived',
  })
  // Also keep a human-readable, bank-name + date labelled copy in factsheets/.
  const friendly = saveFactsheetCopy(adapter, doc, month, buf, via, fetchedAt, hash)
  console.log(`[ulip] ${adapter.id} ${doc.kind} ${month}: saved factsheet copy -> factsheets/${friendly} (${via})`)
  return { doc, rawPath, sha256: hash, via }
}
