// Listing-page helpers: extract PDF links and pick the latest, so adapters never
// hard-code drifting monthly filenames. Pure string parsing; safe to unit-test.
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

export interface PdfLink {
  url: string
  text: string
  month: string | null // YYYY-MM inferred from text/href, if any
}

/** Resolve a possibly-relative href against a base URL. */
function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}

/** Infer a YYYY-MM from arbitrary link text/href (e.g. "May 2026", "2026-05", "may26"). */
export function inferMonth(s: string): string | null {
  const t = s.toLowerCase()
  let m = t.match(/(20\d{2})[-_/ ]?(0[1-9]|1[0-2])/)
  if (m) return `${m[1]}-${m[2]}`
  // "Mon DD, YYYY" / "Mon DD YYYY" (a full date, e.g. "as of Jan 23, 2026") — must be
  // tried BEFORE the month+year form, which would otherwise read the DAY as a 2-digit
  // year ("Jan 23" → 2023-01; this mislabelled every Bharti factsheet).
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s?\d{1,2}[,\s]\s?(20\d{2})\b/)
  if (m) return `${m[2]}-${MONTHS[m[1]]}`
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(20\d{2}|\d{2})\b/)
  if (m) {
    const yr = m[2].length === 2 ? `20${m[2]}` : m[2]
    return `${yr}-${MONTHS[m[1]]}`
  }
  return null
}

/** All <a href="*.pdf"> links on a listing page, with inferred month. */
export function extractPdfLinks(html: string, baseUrl: string): PdfLink[] {
  const out: PdfLink[] = []
  const re = /<a\b[^>]*href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = absolutize(m[1].trim(), baseUrl)
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    out.push({ url, text, month: inferMonth(`${text} ${m[1]}`) })
  }
  return out
}

/**
 * Pick a PDF link, optionally requiring the target month and/or a keyword.
 * If a month IS requested, ONLY an exact match is acceptable — return null otherwise
 * (never silently fall back to the newest/first link, which would archive the WRONG month
 * under the requested month; H-7). With no month requested, prefer the most recent.
 */
export function pickLatestPdf(links: PdfLink[], opts: { month?: string; keyword?: string } = {}): PdfLink | null {
  let cand = links
  if (opts.keyword) {
    const k = opts.keyword.toLowerCase()
    const filtered = cand.filter((l) => `${l.text} ${l.url}`.toLowerCase().includes(k))
    if (filtered.length) cand = filtered
  }
  if (cand.length === 0) return null
  if (opts.month) {
    // Requested a specific month → exact match or nothing (no wrong-month fallback).
    return cand.find((l) => l.month === opts.month) ?? null
  }
  const dated = cand.filter((l) => l.month).sort((a, b) => (a.month! < b.month! ? 1 : -1))
  return dated[0] ?? cand[0]
}
