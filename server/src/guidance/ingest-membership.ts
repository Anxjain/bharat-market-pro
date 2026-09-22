// 9.5: ingest historical NIFTY 500 membership changes (kill survivorship bias).
//
// Source: NSE Indices' own press-release archive (niftyindices.com/press-release) — the
// canonical record of index reconstitutions. The listing page links every "Replacements
// in indices" PDF back to 2004; we fetch the ones since `--since` (default 2023-07-01),
// extract text with local pdftotext (poppler — same tool the ULIP pipeline uses; NO LLM),
// and parse each PDF's "Nifty 500" section into add/remove events with their w.e.f. date.
//
// Parsing is deterministic and STRICT: pdftotext's raw reading order emits each table as
// a numbered company-name block followed by a "Symbol X Y Z" column run (runs may split
// at page breaks and may lag behind the next section's names). We align runs to blocks
// first-fit, requiring consecutive whole runs to sum EXACTLY to the block's name count;
// any mismatch rejects the whole document (logged for manual review) rather than storing
// a guess. Prose one-off exclusions ("Exclusion of X from Nifty indices…", i.e. failed
// spin-off listings) are handled by a narrow regex, again reject-on-doubt.
//
// Honesty note: reconstruction is only correct from the earliest *successfully parsed*
// document forward, and a failed document in the middle punches a hole below which
// backward replay is unreliable — the script prints failures loudly so coverage can be
// judged. Ad-hoc prose announcements that don't match the known formats are skipped.
//
// Usage:
//   npm run guidance:membership                    # ingest since 2023-07-01
//   npm run guidance:membership -- --since=2023-01-01
//   npm run guidance:membership -- --dry-run       # parse + report, no DB writes
//   npm run guidance:membership -- --backfill-delisted  # also fetch Yahoo history for removed names
import '../load-env'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool } from '../db/client'
import * as membershipRepo from '../repositories/indexMembership'
import { ensureHistory } from './history'

const BASE = 'https://www.niftyindices.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CACHE_DIR = join(process.cwd(), 'tmp', 'membership-pdfs')

// ——— pdftotext (poppler). PATH first, then the Git-for-Windows bundled copy. ———
const PDFTOTEXT_CANDIDATES = ['pdftotext', 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe']
function pdfToText(pdfPath: string): string {
  let lastErr: Error | null = null
  for (const bin of PDFTOTEXT_CANDIDATES) {
    try {
      // raw reading order (NOT -layout): -layout interleaves the two physical columns of
      // neighbouring tables; raw mode keeps each table's symbol column as one "Symbol …" run.
      return execFileSync(bin, ['-enc', 'UTF-8', pdfPath, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
    } catch (e) {
      lastErr = e as Error
      if (!/ENOENT/.test(String(e))) throw e
    }
  }
  throw lastErr ?? new Error('pdftotext unavailable')
}

// ——— listing page → press-release items ———
interface PressItem {
  date: string // YYYY-MM-DD (announcement date)
  url: string // absolute PDF URL
  title: string
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/** "Feb 21, 2025" / "September 7, 2023" / "March 28 2024" → YYYY-MM-DD (null if unparseable). */
function parseHumanDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/)
  if (!m) return null
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (!mon) return null
  return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`
}

async function fetchListing(): Promise<PressItem[]> {
  const res = await fetch(`${BASE}/press-release`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`press-release listing HTTP ${res.status}`)
  const html = await res.text()
  const items: PressItem[] = []
  const re = /<div class="pressItem" data-date="([^"]+)"[^>]*>[\s\S]*?<a href='([^']+)'[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const date = parseHumanDate(m[1])
    if (!date) continue
    const title = m[3].replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    items.push({ date, url: BASE + m[2], title })
  }
  return items
}

// ——— PDF parsing: numbered name blocks + "Symbol …" column runs, first-fit aligned ———
const SYM_TOKEN = /^[A-Z0-9&\-]{2,12}$/

interface ParseResult {
  effectiveDate: string | null
  changes: { action: 'add' | 'remove'; symbol: string }[]
  error: string | null
}

export function parseReplacementPdfText(text: string): ParseResult {
  const lines = text.split(/\r?\n/)
  const em = text.match(/effective from\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/)
  const effectiveDate = em ? parseHumanDate(em[1]) : null

  interface Block { section: string; action: 'add' | 'remove'; count: number; inline: string[]; startIdx: number }
  const blocks: Block[] = []
  const runs: { symbols: string[]; idx: number; consumed: boolean }[] = []
  let section: string | null = null
  let action: 'add' | 'remove' | null = null
  let cur: Block | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const h = line.match(/^(?:\d+\)|[a-z]\))\s*(Nifty.+?)\s*:?$/)
    if (h) { section = h[1]; action = null; cur = null; continue }
    if (/^The above replacements?\b/i.test(line) || /^About NSE Indices/i.test(line)) { action = null; cur = null; continue }
    if (/compan(?:y is|ies are) being excluded/i.test(line)) { action = 'remove'; cur = null; continue }
    if (/compan(?:y is|ies are) being included/i.test(line)) { action = 'add'; cur = null; continue }
    const sm = line.match(/^Symbol((?:\s+[A-Z0-9&\-]{2,12})+)$/)
    if (sm) { runs.push({ symbols: sm[1].trim().split(/\s+/), idx: i, consumed: false }); continue }
    // Variant (2026 PDFs): a bare "Symbol" header with the token row on the next
    // non-empty line. A non-token follow-up line just means an empty header — skip it.
    if (/^Symbol$/.test(line)) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      const next = (lines[j] ?? '').replace(/\f/g, ' ').trim()
      if (next && next.split(/\s+/).every((t) => SYM_TOKEN.test(t))) {
        runs.push({ symbols: next.split(/\s+/), idx: i, consumed: false })
        i = j
      }
      continue
    }
    if (action && section) {
      const nm = line.match(/^(\d{1,3})\s+(\S.*)$/)
      if (nm && !/^\d[\d\s]*$/.test(nm[2])) {
        if (!cur || cur.section !== section || cur.action !== action) {
          cur = { section, action, count: 0, inline: [], startIdx: i }
          blocks.push(cur)
        }
        cur.count++
        // inline style: "3 Jindal Stainless Ltd.   JSL" — name text then a trailing symbol token
        const im = nm[2].match(/^(.*[a-z().].*?)\s+([A-Z0-9&\-]{2,12})$/)
        if (im && SYM_TOKEN.test(im[2])) cur.inline.push(im[2])
      }
    }
  }

  // Assign symbols to the Nifty 500 blocks only (matching runs for every section lets a
  // wrong greedy match upstream steal a Nifty 500 run — seen with the Feb-2024 PDF).
  // Inline blocks are self-contained; the rest take consecutive whole runs summing
  // EXACTLY to the block's name count, first-fit from the block's own position (which
  // naturally skips lagging runs from earlier sections: their sizes don't fit).
  const changes: ParseResult['changes'] = []
  let ptr = 0 // preserves excluded-before-included run ordering across N500 blocks
  for (const b of blocks) {
    if (!/^Nifty\s*500$/i.test(b.section)) continue
    let symbols: string[] | null = null
    if (b.inline.length === b.count) {
      symbols = b.inline
    } else if (b.inline.length > 0) {
      return { effectiveDate, changes: [], error: `Nifty 500 ${b.action} block: mixed inline symbols (${b.inline.length}/${b.count})` }
    } else {
      for (let s = ptr; s < runs.length && !symbols; s++) {
        if (runs[s].consumed || runs[s].idx < b.startIdx) continue
        let sum = 0
        const took: number[] = []
        for (let e = s; e < runs.length; e++) {
          if (runs[e].consumed) break
          sum += runs[e].symbols.length
          took.push(e)
          if (sum === b.count) {
            symbols = took.flatMap((k) => runs[k].symbols)
            for (const k of took) runs[k].consumed = true
            ptr = Math.max(ptr, took[took.length - 1] + 1)
            break
          }
          if (sum > b.count) break
        }
      }
      if (!symbols) return { effectiveDate, changes: [], error: `Nifty 500 ${b.action} block: no run alignment for ${b.count} names` }
    }
    for (const sym of symbols) {
      if (!SYM_TOKEN.test(sym)) return { effectiveDate, changes: [], error: `bad symbol token "${sym}"` }
      changes.push({ action: b.action, symbol: sym })
    }
  }

  // A symbol both added and removed in one document means the alignment drifted.
  const adds = new Set(changes.filter((c) => c.action === 'add').map((c) => c.symbol))
  for (const c of changes) if (c.action === 'remove' && adds.has(c.symbol)) return { effectiveDate, changes: [], error: `symbol ${c.symbol} on both sides` }
  return { effectiveDate, changes, error: null }
}

/** Prose one-off exclusions (failed spin-off listings and the like): "…decided to exclude
 *  <Company> (<SYMBOL>) from various indices … effective from <date>…". The symbol is
 *  taken from the exclusion sentence itself, or (when the sentence names only the
 *  company) from a "<Company> (<SYMBOL>)" pairing elsewhere in the document. Only
 *  counted when Nifty 500 is named in the affected-indices list. */
export function parseProseExclusion(raw: string): ParseResult {
  const text = raw.replace(/\s+/g, ' ') // prose wraps lines mid-sentence; flatten first
  if (!/Nifty 500\b/.test(text)) return { effectiveDate: null, changes: [], error: null } // does not affect our index
  // A document can carry SEVERAL exclusion sentences (one per company) — collect them all.
  const sentences = [...text.matchAll(/decided to exclude\s+(.+?)\s+from (?:various|Nifty) indices.{0,120}?effective from\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/g)]
  if (sentences.length === 0) return { effectiveDate: null, changes: [], error: 'prose exclusion: no exclusion sentence match' }
  let effectiveDate: string | null = null
  const changes: ParseResult['changes'] = []
  for (const m of sentences) {
    const date = parseHumanDate(m[2])
    if (!date) return { effectiveDate: null, changes: [], error: `prose exclusion: bad date "${m[2]}"` }
    if (effectiveDate && effectiveDate !== date) return { effectiveDate, changes: [], error: 'prose exclusion: conflicting effective dates' }
    effectiveDate = date
    const entity = m[1].trim()
    // "exclude A (SYMA) and B (SYMB) from…" — every parenthetical symbol counts (dummy
    // placeholder tickers excluded).
    const multi = [...entity.matchAll(/\(([A-Z0-9&\-]{2,12})\)/g)].map((h) => h[1]).filter((s) => !s.startsWith('DUMMY'))
    if (multi.length > 0) {
      for (const symbol of multi) changes.push({ action: 'remove', symbol })
      continue
    }
    let symbol: string | null = null
    if (SYM_TOKEN.test(entity)) symbol = entity // "exclude JIOFIN from …"
    else {
      // Company name only in the sentence — find its "(SYMBOL)" pairing elsewhere.
      const esc = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const paired = text.match(new RegExp(`${esc}\\s*\\(([A-Z0-9&\\-]{2,12})\\)`))
      if (paired) symbol = paired[1]
    }
    if (!symbol && sentences.length === 1) {
      // Pronoun sentence ("…decided to exclude the company…") — the subject is named in the
      // price-band clause: "as <Company> (<SYMBOL>) has not hit …". Only trust a unique hit.
      const hits = new Set([...text.matchAll(/\(([A-Z0-9&\-]{2,12})\)\s+has not hit/g)].map((h) => h[1]))
      if (hits.size === 1) symbol = [...hits][0]
    }
    if (!symbol) return { effectiveDate, changes: [], error: `prose exclusion: no symbol found for "${entity}"` }
    changes.push({ action: 'remove', symbol })
  }
  return { effectiveDate, changes, error: null }
}

// ——— main ———
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const since = args.find((a) => a.startsWith('--since='))?.slice(8) ?? '2023-07-01'
  const dryRun = args.includes('--dry-run')
  const backfillDelisted = args.includes('--backfill-delisted')

  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`[membership] fetching press-release archive (since ${since})…`)
  const items = await fetchListing()
  console.log(`[membership] ${items.length} press releases listed`)

  // Table-format replacements + prose one-off exclusions. Over-inclusion is safe: the
  // parser only emits rows from sections titled exactly "Nifty 500".
  const tableItems = items.filter((x) => x.date >= since && /replacements?\s+in\s+ind/i.test(x.title) && !/SME Emerge|Fixed Income|IPO/i.test(x.title))
  const proseItems = items.filter((x) => x.date >= since && /^Exclusion of /i.test(x.title) && !/SME Emerge|Fixed Income|IPO|Waves/i.test(x.title))
  console.log(`[membership] candidates: ${tableItems.length} table-format, ${proseItems.length} prose exclusions`)

  let totalRows = 0
  let inserted = 0
  const failures: string[] = []
  const dates: string[] = []

  for (const item of [...tableItems, ...proseItems].sort((a, b) => a.date.localeCompare(b.date))) {
    const fname = item.url.split('/').pop()!
    const cached = join(CACHE_DIR, fname)
    try {
      if (!existsSync(cached)) {
        const res = await fetch(item.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf.subarray(0, 5).toString('latin1').includes('%PDF')) throw new Error('not a PDF (WAF page?)')
        writeFileSync(cached, buf)
        await new Promise((r) => setTimeout(r, 300)) // be polite
      }
      const text = pdfToText(cached)
      const isProse = /^Exclusion of /i.test(item.title)
      const parsed = isProse ? parseProseExclusion(text) : parseReplacementPdfText(text)
      if (parsed.error) throw new Error(parsed.error)
      if (parsed.changes.length === 0) continue // no Nifty 500 section in this PR
      if (!parsed.effectiveDate) throw new Error('no effective date found')
      const adds = parsed.changes.filter((c) => c.action === 'add').length
      const rems = parsed.changes.length - adds
      console.log(`[membership] ${item.date} ${fname}: ${adds} add / ${rems} remove w.e.f. ${parsed.effectiveDate} — ${item.title.slice(0, 70)}`)
      totalRows += parsed.changes.length
      dates.push(parsed.effectiveDate)
      if (!dryRun) {
        inserted += await membershipRepo.insertChanges(
          parsed.changes.map((c) => ({ ...c, effectiveDate: parsed.effectiveDate!, source: item.url })),
        )
      }
    } catch (e) {
      failures.push(`${item.date} ${fname}: ${(e as Error).message}`)
    }
  }

  console.log(`\n[membership] parsed ${totalRows} change rows${dryRun ? ' (dry run — nothing stored)' : `, ${inserted} newly inserted`}`)
  if (dates.length) console.log(`[membership] effective-date coverage: ${dates.reduce((a, b) => (a < b ? a : b))} → ${dates.reduce((a, b) => (a > b ? a : b))}`)
  if (failures.length) {
    console.warn(`[membership] ${failures.length} document(s) skipped (backward replay is unreliable below the newest of these):`)
    for (const f of failures) console.warn(`  ✗ ${f}`)
  }
  if (!dryRun) {
    console.log(`[membership] ledger now holds ${await membershipRepo.count()} rows`)
    // Reconciliation: the checker anchors on the instruments master as "today's members".
    // A symbol whose latest ledger action disagrees with the master means either the
    // master is stale or we missed a press release — flag it, don't guess.
    const { listSymbols } = await import('../repositories/instruments')
    const current = new Set((await listSymbols()).map((s) => s.toUpperCase()))
    const latest = new Map<string, 'add' | 'remove'>()
    for (const c of await membershipRepo.changesAsc()) latest.set(c.symbol, c.action as 'add' | 'remove')
    const drift: string[] = []
    for (const [sym, action] of latest) {
      if (action === 'remove' && current.has(sym)) drift.push(`${sym}: ledger says removed but instruments has it`)
      if (action === 'add' && !current.has(sym)) drift.push(`${sym}: ledger says added but instruments lacks it`)
    }
    if (drift.length) {
      console.warn(`[membership] ${drift.length} ledger/instruments drift warning(s) — point-in-time answers for these names are unreliable:`)
      for (const d of drift) console.warn(`  ! ${d}`)
    }
  }

  if (backfillDelisted && !dryRun) {
    // Best-effort delisted-ticker history: Yahoo often still serves partial series for
    // removed .NS names. Failures are expected (truly delisted/renamed) and fine.
    const gone = await membershipRepo.removedNotCurrent()
    console.log(`\n[membership] --backfill-delisted: ${gone.length} removed symbols not in instruments`)
    let ok = 0
    for (const sym of gone) {
      try {
        const rows = await ensureHistory(sym, { minRows: 100 })
        if (rows > 0) { ok++; console.log(`  ✓ ${sym}: ${rows} bars`) }
        else console.log(`  ✗ ${sym}: no data from Yahoo`)
      } catch (e) {
        console.log(`  ✗ ${sym}: ${(e as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    console.log(`[membership] delisted backfill: ${ok}/${gone.length} symbols got history`)
  }
}

// Direct invocation guard (same pattern as db/migrate.ts).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ingest-membership.ts')) {
  main()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[membership] failed:', e)
      process.exit(1)
    })
}
