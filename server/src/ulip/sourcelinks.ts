// Per-fund source-link resolution for the ULIP monitor.
//
// Each fund page shows a "source factsheet" link. It must open the EXACT source for
// THAT fund and month:
//   • per-fund-PDF insurers (Tata AIA) → that fund's own PDF;
//   • combined-PDF insurers (HDFC/Kotak/PNB/Bharti/Bandhan/SBI/ICICI) → the month's
//     factsheet PDF, deep-linked to the fund's page (#page=N);
//   • months where we archived no PDF → the insurer's live fund-factsheet webpage.
//
// The heavy lifting (which page a fund is on) is precomputed by the source-pages
// detection script into funds.source_kind / funds.source_page; this module just
// resolves a fund + its sources rows into the link the API/endpoint should use.
import { basename, join } from 'node:path'
import { RAW_DIR } from './config'
import type { SourceRow } from '../repositories/sources'

/**
 * Candidate on-disk locations for an archived source, most-specific first. The stored
 * raw_path may be from another machine (e.g. a Windows `E:\…\raw\kotak\2026-05\x.pdf`
 * ingest path), so besides the literal path we re-root everything after the `raw/`
 * segment under THIS machine's RAW_DIR — which matches the archive's <adapterId>/<month>
 * layout regardless of OS or where it was first fetched.
 */
export function rawCandidates(rawPath: string): string[] {
  const norm = rawPath.replace(/\\/g, '/')
  const out = [norm]
  const m = norm.match(/(?:^|\/)raw\/(.+)$/i)
  if (m) out.push(join(RAW_DIR, m[1]))
  return out
}

// Public fund-factsheet landing pages, per IRDAI insurer code — the fallback when we
// have no archived PDF for that month (can't deep-link a specific fund on most of these
// sites, but it's the page that lists the fund). Best-effort, public URLs.
// Canonical fund-factsheet / fund-performance landing pages (from docs/ulip-sources.md,
// user-verified 2026-06-25). The fallback when a month has no archived PDF to deep-link.
export const INSURER_FUND_PAGE: Record<string, string> = {
  '101': 'https://www.hdfclife.com/fund-performance',
  '105': 'https://www.iciciprulife.com/fund-performance/all-products-fund-performance-details.html',
  '107': 'https://www.kotaklife.com/how-do-i/fund-update',
  '110': 'https://www.tataaia.com/customer-service/fact-sheet.html',
  // SBI: the nav-and-fund-performance page is a generic explainer with NO documents on
  // it — the monthly ULIP newsletters actually live in the download centre (audited in a
  // real browser 2026-07-06; the PDF hrefs are mid-path `.pdf/<uuid>` documents links).
  '111': 'https://www.sbilife.co.in/customer-services/download-centre/ulip-newsletters?category=21587756',
  '117': 'https://www.pnbmetlife.com/investments/fund-update/2026.html',
  '128': 'https://www.shriramlife.com/services/nav-history',
  '130': 'https://www.bhartiaxa.com/manage-funds/newsletter-and-fund-factsheet',
  '136': 'https://www.canarahsbclife.com/funds-navs/investment-newsletter',
  '138': 'https://www.bandhanlife.com/fund-performance/investment-details',
}

/** Slug a fund name the way Tata's per-fund `kind` (fund:<slug>) is formed. */
export function fundSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface FundLite {
  sfin: string
  insurer: string
  name: string
  sourceKind?: string | null
  sourcePage?: number | null
}

/** A source row whose archived PDF we hold (parse succeeded → the file was stored). The
 *  serving endpoint resolves the actual file under RAW_DIR and gracefully redirects to
 *  the live URL if it's somehow absent, so a lenient check here is safe. */
export function isServablePdf(s: SourceRow | undefined | null): boolean {
  return !!s && s.parseStatus === 'stored' && !!s.rawPath
}

/**
 * Pick the sources row that backs a specific fund:
 *   • prefer an exact match on the fund's stored source_kind;
 *   • else, if there's only one source for the month, use it (combined PDF);
 *   • else (per-fund insurer, no stored kind) match by name slug.
 */
export function pickSource(fund: FundLite, sources: SourceRow[]): SourceRow | null {
  if (sources.length === 0) return null
  if (fund.sourceKind) {
    const exact = sources.find((s) => s.kind === fund.sourceKind)
    if (exact) return exact
  }
  if (sources.length === 1) return sources[0]
  const slug = fundSlug(fund.name)
  // EXACT slug match only (after stripping to bare alphanumerics). Never bidirectional
  // substring — "flexi-growth-fund" must not match "flexi-growth-fund-ii" (a different fund).
  const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = bare(slug)
  return (
    sources.find((s) => s.kind === `fund:${slug}`) ??
    sources.find((s) => s.kind.startsWith('fund:') && bare(s.kind.slice(5)) === target) ??
    null
  )
}

export interface ResolvedSource {
  type: 'pdf' | 'web'
  href: string // 'pdf' → our streaming endpoint; 'web' → the live URL/fallback
  page: number | null // append as #page=N client-side (PDF viewers honour it)
  label: string
  fileName: string | null // basename of the archived PDF (for the Content-Disposition)
}

/** Resolve the source link shown on a fund page (and used by the streaming endpoint). */
export function resolveFundSource(fund: FundLite, month: string, sources: SourceRow[]): ResolvedSource {
  const src = pickSource(fund, sources)
  const page = fund.sourcePage ?? null

  if (isServablePdf(src)) {
    const p = page ?? 1
    return {
      type: 'pdf',
      href: `/api/ulip/source/${encodeURIComponent(fund.sfin)}?month=${encodeURIComponent(month)}`,
      page: p,
      label: `source factsheet (PDF${p ? ` · p.${p}` : ''})`,
      fileName: src!.rawPath ? basename(src!.rawPath.replace(/\\/g, '/')) : null,
    }
  }
  // A source row with a live URL (fetch failed / not archived) — link the live doc.
  if (src?.url) {
    const isPdf = /\.pdf(\?|$)/i.test(src.url)
    return {
      type: 'web',
      href: src.url,
      page: isPdf ? page : null,
      label: isPdf ? 'source factsheet (live PDF)' : 'source factsheet (live page)',
      fileName: null,
    }
  }
  // No source row for this month at all → the insurer's public fund-factsheet page.
  const fallback = INSURER_FUND_PAGE[fund.insurer]
  return { type: 'web', href: fallback ?? '', page: null, label: 'insurer fund page (live)', fileName: null }
}
