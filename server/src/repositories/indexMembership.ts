// Repository: point-in-time index membership (9.5 — kill survivorship bias).
//
// The `index_membership` table is an append-only ledger of add/remove events with
// effective dates (from NSE Indices press releases). The instruments table is TODAY's
// NIFTY 500; membership as-of a past date is reconstructed by replaying the ledger
// BACKWARD from today: undo every change that took effect AFTER the query date (an
// 'add' effective later means the symbol was NOT yet a member; a 'remove' effective
// later means it still WAS). Coverage is only as good as the earliest recorded change —
// before that date reconstruction is impossible and callers must fall back to the
// survivor-conditioned sample (and say so).
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { indexMembership } from '../db/schema'
import * as instrumentsRepo from './instruments'

export interface MembershipChange {
  symbol: string
  action: 'add' | 'remove'
  effectiveDate: string // YYYY-MM-DD
  source: string
}

export const DEFAULT_INDEX = 'NIFTY500'

/** Idempotent insert — the unique (index, symbol, action, date) key absorbs re-runs. */
export async function insertChanges(changes: MembershipChange[], indexName = DEFAULT_INDEX): Promise<number> {
  if (changes.length === 0) return 0
  const now = new Date().toISOString()
  const values = changes.map((c) => ({
    indexName,
    symbol: c.symbol.toUpperCase(),
    action: c.action,
    effectiveDate: c.effectiveDate,
    source: c.source,
    createdAt: now,
  }))
  let inserted = 0
  const CHUNK = 500
  for (let i = 0; i < values.length; i += CHUNK) {
    const res = await db
      .insert(indexMembership)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoNothing()
      .returning({ id: indexMembership.id })
    inserted += res.length
  }
  return inserted
}

/** All recorded changes, oldest first (stable order for replay). */
export async function changesAsc(indexName = DEFAULT_INDEX): Promise<MembershipChange[]> {
  const rows = await db
    .select({
      symbol: indexMembership.symbol,
      action: indexMembership.action,
      effectiveDate: indexMembership.effectiveDate,
      source: indexMembership.source,
    })
    .from(indexMembership)
    .where(eq(indexMembership.indexName, indexName))
    .orderBy(asc(indexMembership.effectiveDate), asc(indexMembership.symbol))
  return rows as MembershipChange[]
}

export async function count(indexName = DEFAULT_INDEX): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(indexMembership)
    .where(eq(indexMembership.indexName, indexName))
  return rows[0]?.n ?? 0
}

/** Symbols with a 'remove' event that are no longer in the instruments master —
 *  candidates for best-effort delisted-history backfill. */
export async function removedNotCurrent(indexName = DEFAULT_INDEX): Promise<string[]> {
  const [removed, current] = await Promise.all([
    db
      .selectDistinct({ symbol: indexMembership.symbol })
      .from(indexMembership)
      .where(and(eq(indexMembership.indexName, indexName), eq(indexMembership.action, 'remove'))),
    instrumentsRepo.listSymbols(),
  ])
  const cur = new Set(current.map((s) => s.toUpperCase()))
  return removed.map((r) => r.symbol).filter((s) => !cur.has(s.toUpperCase()))
}

// ——— point-in-time checker ———

export interface MembershipChecker {
  /** Was `symbol` in the index on `date`? Only meaningful for date ≥ coverageStart. */
  wasMember(symbol: string, date: string): boolean
  /** Earliest effective date in the ledger — reconstruction is honest only from here. */
  coverageStart: string | null
  /** A full point-in-time member set (replayed backward from today), memoized per date. */
  membershipAsOf(date: string): Set<string>
}

/**
 * Build an in-memory checker once (current members + the whole ledger); `wasMember` then
 * costs O(changes for that symbol). Walking a symbol's changes newest→oldest, every
 * change effective AFTER the query date is undone; the last one visited (the oldest
 * change still after the date) fixes the state at that date.
 */
export async function buildChecker(indexName = DEFAULT_INDEX): Promise<MembershipChecker> {
  const [currentSymbols, changes] = await Promise.all([instrumentsRepo.listSymbols(), changesAsc(indexName)])
  const current = new Set(currentSymbols.map((s) => s.toUpperCase()))
  const bySymbol = new Map<string, MembershipChange[]>() // ascending per symbol
  for (const c of changes) {
    const list = bySymbol.get(c.symbol) ?? []
    list.push(c)
    bySymbol.set(c.symbol, list)
  }
  const coverageStart = changes[0]?.effectiveDate ?? null
  const asOfCache = new Map<string, Set<string>>()

  const wasMember = (symbol: string, date: string): boolean => {
    const sym = symbol.toUpperCase()
    let member = current.has(sym)
    const list = bySymbol.get(sym)
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].effectiveDate <= date) break // change already in effect on `date`
        member = list[i].action !== 'add' // undo: pre-add = out, pre-remove = in
      }
    }
    return member
  }

  const membershipAsOf = (date: string): Set<string> => {
    const day = date.slice(0, 10)
    const hit = asOfCache.get(day)
    if (hit) return hit
    const set = new Set(current)
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]
      if (c.effectiveDate <= day) break
      if (c.action === 'add') set.delete(c.symbol)
      else set.add(c.symbol)
    }
    asOfCache.set(day, set)
    return set
  }

  return { wasMember, coverageStart, membershipAsOf }
}

// Signal-path convenience: one shared checker, rebuilt at most every 15 minutes (the
// ledger changes ~monthly; per-request rebuilds would re-read the whole table for nothing).
let cached: { at: number; checker: MembershipChecker } | null = null
const TTL_MS = 15 * 60 * 1000

export async function cachedChecker(indexName = DEFAULT_INDEX): Promise<MembershipChecker> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.checker
  const checker = await buildChecker(indexName)
  cached = { at: Date.now(), checker }
  return checker
}
