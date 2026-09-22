// Repository: watchlists (optional per-account symbol sync).
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { watchlists } from '../db/schema'

export async function get(userId: string): Promise<string[] | null> {
  const rows = await db.select({ symbols: watchlists.symbols }).from(watchlists).where(eq(watchlists.userId, userId)).limit(1)
  return rows[0]?.symbols ?? null
}

export async function set(userId: string, email: string | null, symbols: string[]): Promise<string[]> {
  const clean = [...new Set(symbols.filter(Boolean))]
  await db
    .insert(watchlists)
    .values({ userId, email, symbols: clean, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: watchlists.userId, set: { email: sql`excluded.email`, symbols: sql`excluded.symbols`, updatedAt: sql`excluded.updated_at` } })
  return clean
}

/** Union of EVERY account's saved symbols — the alert-rules 'watchlist' universe
 *  (9.7). Anonymous browser-only watchlists never reach the server, so those
 *  symbols can't participate until the user signs in and syncs. */
export async function allSymbols(): Promise<string[]> {
  const rows = await db.select({ symbols: watchlists.symbols }).from(watchlists)
  return [...new Set(rows.flatMap((r) => r.symbols))]
}

/** Union the incoming (local) symbols into the account's saved set — never wipes. */
export async function merge(userId: string, email: string | null, incoming: string[]): Promise<string[]> {
  const existing = (await get(userId)) ?? []
  const union = [...new Set([...existing, ...incoming.filter(Boolean)])]
  return set(userId, email, union)
}
