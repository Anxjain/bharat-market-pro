// Shared, dependency-light helpers deduplicated out of the backend core modules
// (per the 2026-07-02 audit — "LOW: duplicated utils"). Keep this module pure and
// side-effect-free so it's safe to import from anywhere (repos, adapters, CLIs).

import { readFileSync, existsSync } from 'node:fs'
import Parser from 'rss-parser'

// ——— .env loader (shared by load-env.ts and llm.ts) ———
/** Parse a KEY=VALUE .env file into process.env without overriding set vars. */
export function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

// ——— Stable id hash (shared by filings-nse.ts and news-rss.ts) ———
/** Two independent FNV-1a passes -> ~64-bit id space, pure, low collision risk. */
export function hashId(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca77)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

// ——— Regex helpers (shared by chat.ts and news-rss.ts) ———
/** Escape regex metacharacters so symbols like M&M / L&TFH match literally. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
/** Word-boundary regex — 'win' won't match inside 'winter', 'titan' not in 'titanium'. */
export function wordRe(term: string): RegExp {
  return new RegExp(`\\b${escapeRe(term)}\\b`, 'i')
}

// ——— Calendar helpers (shared by scheduler.ts and the ULIP CLIs) ———
/** YYYY-MM for the previous calendar month — the factsheet month just published. */
export function prevMonth(d = new Date()): string {
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  m.setUTCMonth(m.getUTCMonth() - 1)
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`
}

// ——— RSS parser factory (shared UA + timeouts) ———
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
/** Build an rss-parser with a shared browser UA (some feeds 403 an empty UA). */
export function makeRssParser(timeoutMs: number, ua = true): Parser {
  return ua
    ? new Parser({ timeout: timeoutMs, headers: { 'User-Agent': BROWSER_UA } })
    : new Parser({ timeout: timeoutMs })
}
