// Company fact sheet - sourced from screener.in (the user-preferred public
// source; NSE/BSE stat APIs block automated access). Parsed fields:
//   - headline ratios (Market Cap, P/E, ROE, ROCE, Book Value, Dividend Yield...)
//   - the "About" company profile paragraph
//   - screener's pros/cons analysis bullets
// Cached in Postgres for 24h per symbol; every payload carries source attribution.

import * as factSheetsRepo from './repositories/factSheets'
import { setDomain } from './repositories/instruments'

export interface FactSheet {
  symbol: string
  source: 'screener.in'
  url: string
  asOf: string
  ratios: { label: string; value: string }[]
  about: string | null
  pros: string[]
  cons: string[]
  /** Company website host (e.g. "ril.com") - drives the logo via the favicon CDN. */
  domain: string | null
}

/** Reduce a raw website URL/host to a bare host (no scheme, no www., no path). */
function toDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .toLowerCase()
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }
const TTL_MS = 24 * 60 * 60 * 1000

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x20b9;|&#8377;/gi, '₹')
    .replace(/\s+/g, ' ')
    .trim()
}

function parse(html: string, symbol: string, url: string): FactSheet {
  // Narrow to the headline-ratios list (<ul id="top-ratios">...</ul>) so stray
  // class="name" spans elsewhere on the page aren't captured. Fall back to the
  // whole document if the container markup ever changes (the >=4 guard still
  // protects callers).
  const topBlock = html.match(/<ul[^>]*id="top-ratios"[^>]*>([\s\S]*?)<\/ul>/)
  const ratioScope = topBlock ? topBlock[1] : html

  // Headline ratios: <li ...><span class="name">Label</span><span class="value">...</span></li>
  const ratios: { label: string; value: string }[] = []
  // Capture the full <li> so nested spans (units, high/low pairs) survive.
  const ratioRe = /<span class="name">([\s\S]*?)<\/span>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = ratioRe.exec(ratioScope)) !== null && ratios.length < 12) {
    const label = stripTags(m[1])
    const value = stripTags(m[2])
    if (label && value) ratios.push({ label, value })
  }

  // About paragraph (company profile box)
  const aboutMatch = html.match(/class="company-profile"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
  const about = aboutMatch ? stripTags(aboutMatch[1]).slice(0, 800) : null

  // Company website - the first <a href> inside the company-links block is the
  // official site (subsequent links are BSE/NSE). Used to fetch the brand logo.
  const linksBlock = html.match(/class="company-links[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  const firstHref = linksBlock?.[1].match(/<a[^>]+href="([^"]+)"/)
  const domain = toDomain(firstHref?.[1])

  // Pros / cons analysis bullets
  const grab = (cls: string): string[] => {
    const sec = html.match(new RegExp(`class="${cls}"[\\s\\S]*?<ul>([\\s\\S]*?)<\\/ul>`))
    if (!sec) return []
    return [...sec[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x) => stripTags(x[1])).filter(Boolean).slice(0, 5)
  }

  return {
    symbol,
    source: 'screener.in',
    url,
    asOf: new Date().toISOString(),
    ratios,
    about,
    pros: grab('pros'),
    cons: grab('cons'),
    domain,
  }
}

/** M-B11: a corrupt cached row must not 500 the endpoint forever — treat unparseable
 *  JSON as a cache miss so we re-scrape instead of throwing. */
function safeParse(json: string): FactSheet | null {
  try {
    return JSON.parse(json) as FactSheet
  } catch {
    return null
  }
}

export async function getFactSheet(symbol: string): Promise<FactSheet | null> {
  const sym = symbol.toUpperCase()
  const cached = await factSheetsRepo.get(sym)
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < TTL_MS) {
    const parsed = safeParse(cached.json)
    if (parsed) return parsed // else fall through and re-scrape
  }

  // Consolidated figures preferred; standalone as fallback (some companies have no consolidated page)
  for (const variant of [`https://www.screener.in/company/${sym}/consolidated/`, `https://www.screener.in/company/${sym}/`]) {
    try {
      const res = await fetch(variant, { headers: UA, signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      if (!res.ok) continue
      const html = await res.text()
      const sheet = parse(html, sym, variant)
      if (sheet.ratios.length >= 4) {
        await factSheetsRepo.upsert(sym, JSON.stringify(sheet), new Date().toISOString())
        // Persist the resolved logo domain on the instruments master (cheap, idempotent).
        if (sheet.domain) await setDomain(sym, sheet.domain)
        return sheet
      }
    } catch {
      /* try next variant */
    }
  }
  // Serve stale cache rather than nothing (guarded: a corrupt row → null, not a throw).
  return cached ? safeParse(cached.json) : null
}
