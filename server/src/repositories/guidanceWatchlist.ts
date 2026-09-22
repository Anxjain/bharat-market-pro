// Repository: guidance watchlist (private, owner-curated watch universe).
import { eq, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceWatchlist } from '../db/schema'

export interface WatchEntry {
  symbol: string
  sectorThesis: string | null
  tags: string[]
  active: boolean
  addedAt: string
}

export async function list(includeInactive = false): Promise<WatchEntry[]> {
  const rows = await db.select().from(guidanceWatchlist).orderBy(asc(guidanceWatchlist.symbol))
  return rows.filter((r) => includeInactive || r.active)
}

export async function add(symbol: string, sectorThesis: string | null, tags: string[]): Promise<void> {
  await db
    .insert(guidanceWatchlist)
    .values({ symbol: symbol.toUpperCase(), sectorThesis, tags, active: true, addedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: guidanceWatchlist.symbol,
      set: { sectorThesis: sql`excluded.sector_thesis`, tags: sql`excluded.tags`, active: sql`true` },
    })
}

export async function setActive(symbol: string, active: boolean): Promise<void> {
  await db.update(guidanceWatchlist).set({ active }).where(eq(guidanceWatchlist.symbol, symbol.toUpperCase()))
}

export async function remove(symbol: string): Promise<void> {
  await db.delete(guidanceWatchlist).where(eq(guidanceWatchlist.symbol, symbol.toUpperCase()))
}
