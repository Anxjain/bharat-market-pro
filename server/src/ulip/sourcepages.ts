// Detect, per fund, WHICH source PDF backs it and WHICH page its factsheet is on, and
// persist that onto funds.source_kind / funds.source_page. Powers the exact "open the
// PDF at this fund's page" link.
//
//   npm run ulip:source-pages                 -> every insurer-month with a PDF
//   npm run ulip:source-pages -- 2026-05       -> just that month
//   npm run ulip:source-pages -- 2026-05 107   -> that month + insurer (Kotak)
//
// Needs `pdftotext` (poppler) on PATH and the archived PDFs reachable at their
// sources.raw_path (normalised to RAW_DIR when the stored path is a foreign OS path).
import '../load-env'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client'
import { funds } from '../db/schema'
import * as sourcesRepo from '../repositories/sources'
import type { SourceRow } from '../repositories/sources'
import { normalizeSfin } from './types'
import { isServablePdf, pickSource, rawCandidates, type FundLite } from './sourcelinks'

/** First on-disk location of an archived source that exists on THIS machine. */
function resolvePath(s: SourceRow): string | null {
  return rawCandidates(s.rawPath).find((p) => existsSync(p)) ?? null
}

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const normSf = (s: string) => alnum(normalizeSfin(s))

const pagesCache = new Map<string, string[]>()
/** pdftotext → array of per-page text (split on form-feed), upper-cased & alnum-only. */
function pdfPages(file: string): string[] {
  if (pagesCache.has(file)) return pagesCache.get(file)!
  const raw = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const pages = raw.split('\f').map((p) => alnum(p))
  pagesCache.set(file, pages)
  return pages
}

/**
 * 1-based page of a fund's factsheet in a combined PDF.
 *
 * Combined factsheets open with an INDEX page that lists every fund's SFIN, so a naive
 * "first page containing the SFIN" always returns the index. We instead take, among the
 * pages that contain this fund's SFIN (or, failing that, its name), the one carrying the
 * FEWEST distinct fund-SFINs — the index mentions them all; a real factsheet page carries
 * essentially just its own. Ties break to the later page (factsheets follow the index).
 */
function findPage(pages: string[], allSfins: string[], sfin: string, name: string): number | null {
  const density = pages.map((p) => allSfins.reduce((n, s) => n + (s.length >= 10 && p.includes(s) ? 1 : 0), 0))
  const sf = normSf(sfin)
  let cands = sf.length >= 10 ? pages.map((_, i) => i).filter((i) => pages[i].includes(sf)) : []
  if (cands.length === 0) {
    const nm = alnum(name)
    if (nm.length >= 8) cands = pages.map((_, i) => i).filter((i) => pages[i].includes(nm))
  }
  if (cands.length === 0) return null
  cands.sort((a, b) => density[a] - density[b] || b - a) // fewest fund-SFINs, then later page
  return cands[0] + 1
}

export async function runSourcePages(monthFilter?: string, insurerFilter?: string): Promise<void> {
  const rows = await db.select().from(funds)
  const scoped = rows.filter((f) => (!monthFilter || f.month === monthFilter) && (!insurerFilter || f.insurer === insurerFilter))
  // Group by (insurer, month).
  const groups = new Map<string, typeof scoped>()
  for (const f of scoped) {
    const k = `${f.insurer}|${f.month}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(f)
  }

  let matched = 0
  let missing = 0
  for (const [key, gfunds] of groups) {
    const [insurer, month] = key.split('|')
    const sources = await sourcesRepo.listByInsurerMonth(insurer, month)
    const perFund = sources.length > 1 && sources.every((s) => s.kind.startsWith('fund:'))
    const allSfins = gfunds.map((f) => normSf(f.sfin))

    for (const f of gfunds) {
      const lite: FundLite = { sfin: f.sfin, insurer: f.insurer, name: f.name }
      const src = pickSource(lite, sources)
      let sourceKind: string | null = src?.kind ?? null
      let page: number | null = null

      if (src && isServablePdf(src)) {
        if (perFund) {
          page = 1 // each per-fund PDF IS this fund
        } else {
          const file = resolvePath(src)
          if (file) {
            try { page = findPage(pdfPages(file), allSfins, f.sfin, f.name) } catch (e) { console.warn(`  ${f.sfin}: pdftotext failed — ${(e as Error).message}`) }
          }
        }
      }
      if (sourceKind || page != null) {
        // `page ?? undefined` so a pdftotext failure (page stays null) does NOT clobber a
        // previously-detected good page — drizzle omits undefined keys from the UPDATE (M-U6).
        await db.update(funds).set({ sourceKind, sourcePage: page ?? undefined }).where(and(eq(funds.sfin, f.sfin), eq(funds.month, f.month)))
        matched++
      } else {
        missing++
      }
    }
    console.log(`[source-pages] ${insurer} ${month}: ${gfunds.length} funds, ${perFund ? 'per-fund PDFs' : sources.length === 1 ? '1 combined PDF' : 'no servable PDF'}`)
  }
  console.log(`[source-pages] done — ${matched} funds resolved, ${missing} left to live-webpage fallback`)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('sourcepages.ts')) {
  const month = process.argv[2] && /^\d{4}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : undefined
  const insurer = process.argv[3] || (process.argv[2] && !month ? process.argv[2] : undefined)
  runSourcePages(month, insurer)
    .then(() => pool.end())
    .catch((e) => { console.error('[source-pages] fatal:', e); process.exit(1) })
}
