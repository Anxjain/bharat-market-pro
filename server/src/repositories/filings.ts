// Repository: filings (NSE corporate disclosures).
import { and, eq, ne, desc, gte } from 'drizzle-orm'
import { db } from '../db/client'
import { filings } from '../db/schema'

export interface FilingRow {
  id: string
  exchange: string
  symbol: string | null
  company: string
  category: string
  title: string
  filedAt: string
  link: string
  summary: string | null
  materiality: string
  ai: boolean
}

export async function upsertFilings(
  rows: { id: string; exchange: string; symbol: string | null; company: string; category: string; title: string; filedAt: string; link: string; materiality: string }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await db.insert(filings).values(rows).onConflictDoNothing({ target: filings.id })
  return rows.length
}

export async function latest(limit: number): Promise<FilingRow[]> {
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
    .orderBy(desc(filings.filedAt))
    .limit(limit)
}

/** Recent filings for one symbol since an ISO cutoff — the sell advisor's evidence feed. */
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
    .where(and(eq(filings.symbol, symbol), gte(filings.filedAt, sinceIso)))
    .orderBy(desc(filings.filedAt))
    .limit(20)
}

/** Auto-mark routine low-materiality rows as enriched (no AI digest needed). */
export async function markLowEnriched(): Promise<void> {
  await db.update(filings).set({ ai: true }).where(and(eq(filings.ai, false), eq(filings.materiality, 'low')))
}

export async function unenriched(
  limit: number,
): Promise<{ id: string; company: string; category: string; title: string; materiality: string }[]> {
  return db
    .select({ id: filings.id, company: filings.company, category: filings.category, title: filings.title, materiality: filings.materiality })
    .from(filings)
    .where(and(eq(filings.ai, false), ne(filings.materiality, 'low')))
    .orderBy(desc(filings.filedAt))
    .limit(limit)
}

export async function markEnriched(id: string, summary: string, materiality: string): Promise<void> {
  await db.update(filings).set({ summary, materiality, ai: true }).where(eq(filings.id, id))
}
