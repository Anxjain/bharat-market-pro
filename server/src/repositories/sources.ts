// Repository: sources (raw-first archive ledger).
import { and, eq, desc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { sources } from '../db/schema'

export interface SourceRow {
  insurer: string
  month: string
  kind: string
  rawPath: string
  url: string | null
  sha256: string
  fetchedAt: string
  parseStatus: string
}

export async function get(insurer: string, month: string, kind: string): Promise<SourceRow | null> {
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.insurer, insurer), eq(sources.month, month), eq(sources.kind, kind)))
    .limit(1)
  return rows[0] ?? null
}

export async function listByInsurerMonth(insurer: string, month: string): Promise<SourceRow[]> {
  return db.select().from(sources).where(and(eq(sources.insurer, insurer), eq(sources.month, month)))
}

export async function upsert(row: SourceRow): Promise<void> {
  await db
    .insert(sources)
    .values(row)
    .onConflictDoUpdate({
      target: [sources.insurer, sources.month, sources.kind],
      set: {
        rawPath: sql`excluded.raw_path`,
        url: sql`excluded.url`,
        sha256: sql`excluded.sha256`,
        fetchedAt: sql`excluded.fetched_at`,
        parseStatus: sql`excluded.parse_status`,
      },
    })
}

export async function setParseStatus(insurer: string, month: string, kind: string, status: string): Promise<void> {
  await db
    .update(sources)
    .set({ parseStatus: status })
    .where(and(eq(sources.insurer, insurer), eq(sources.month, month), eq(sources.kind, kind)))
}

export async function listByInsurer(insurer: string): Promise<SourceRow[]> {
  return db.select().from(sources).where(eq(sources.insurer, insurer)).orderBy(desc(sources.month))
}
