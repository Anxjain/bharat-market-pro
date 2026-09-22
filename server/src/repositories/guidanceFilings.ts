// Repository: guidance-local, per-symbol filings query (H-11).
//
// The guidance desk needs a symbol-scoped, time-windowed view of NSE filings for its
// thesis-breaker / catalyst logic (dilution, auditor/rating flags, upcoming board
// meetings). The shared `repositories/filings.latest(n)` returns the newest n rows across
// the WHOLE market, so filtering it by symbol after the fact yields only a few days of
// history for any one name — the advertised 30/120-day lookbacks were illusory, and a
// dilution/QIP could sit just outside the window (a name reads "high-conviction" days
// after announcing a raise).
//
// This reads the `filings` table directly (a read-only query over another team's schema —
// filings.ts itself is untouched) filtered to one symbol since a cutoff.
//
// CROSS-FILE NOTE (see report): the ideal home is `repositories/filings.forSymbolSince`
// with a composite index on (symbol, filedAt) — that file is owned by another engineer,
// so the query lives here for now. A `filings (symbol, filedAt)` index is recommended for
// performance once row counts grow.
import { and, eq, gte, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { filings } from '../db/schema'
import type { FilingRow } from './filings'

/** All filings for one symbol filed at/after `sinceIso` (newest first). */
export async function forSymbolSince(symbol: string, sinceIso: string): Promise<FilingRow[]> {
  return db
    .select({
      id: filings.id,
      exchange: filings.exchange,
      symbol: filings.symbol,
      company: filings.company,
      category: filings.category,
      title: filings.title,
      filedAt: filings.filedAt,
      link: filings.link,
      summary: filings.summary,
      materiality: filings.materiality,
      ai: filings.ai,
    })
    .from(filings)
    .where(and(eq(filings.symbol, symbol.toUpperCase()), gte(filings.filedAt, sinceIso)))
    .orderBy(desc(filings.filedAt))
    .limit(400)
}
