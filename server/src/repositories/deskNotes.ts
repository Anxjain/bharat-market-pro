// Repository: desk_notes (AI desk notes per company).
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { deskNotes } from '../db/schema'

export async function get(symbol: string): Promise<{ note: string; ai: boolean; updatedAt: string } | null> {
  const rows = await db
    .select({ note: deskNotes.note, ai: deskNotes.ai, updatedAt: deskNotes.updatedAt })
    .from(deskNotes)
    .where(eq(deskNotes.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

export async function upsert(symbol: string, note: string, ai: boolean, updatedAt: string): Promise<void> {
  await db
    .insert(deskNotes)
    .values({ symbol, note, ai, updatedAt })
    .onConflictDoUpdate({
      target: deskNotes.symbol,
      set: { note: sql`excluded.note`, ai: sql`excluded.ai`, updatedAt: sql`excluded.updated_at` },
    })
}
