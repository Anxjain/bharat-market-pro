// Repository: paper trading (guidance_stars / guidance_pt_account / guidance_pt_positions).
// Everything is scoped to a user (the verified owner email from the auth token) — each
// login has its own stars, mock account and positions. Pure data access; fill/stop
// mechanics live in guidance/portfolio.ts.
import { eq, and, desc, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceStars, guidancePtAccount, guidancePtPositions, guidanceSnapshots } from '../db/schema'

// ——— stars (each user's private investment watchlist) ———

export interface StarRow {
  symbol: string
  starredAt: string
}

export async function listStars(user: string): Promise<StarRow[]> {
  return db
    .select({ symbol: guidanceStars.symbol, starredAt: guidanceStars.starredAt })
    .from(guidanceStars)
    .where(eq(guidanceStars.userEmail, user))
    .orderBy(desc(guidanceStars.starredAt))
}

export async function addStar(user: string, symbol: string): Promise<void> {
  await db.insert(guidanceStars).values({ userEmail: user, symbol, starredAt: new Date().toISOString() }).onConflictDoNothing()
}

export async function removeStar(user: string, symbol: string): Promise<void> {
  await db.delete(guidanceStars).where(and(eq(guidanceStars.userEmail, user), eq(guidanceStars.symbol, symbol)))
}

// ——— account (one row per user) ———

export interface Account {
  userEmail: string
  startingCapital: number
  cash: number
  createdAt: string
  updatedAt: string
}

export const DEFAULT_CAPITAL = 10_000_000 // ₹1 crore mock cash

export async function getAccount(user: string): Promise<Account> {
  const rows = await db.select().from(guidancePtAccount).where(eq(guidancePtAccount.userEmail, user))
  if (rows[0]) return rows[0]
  const now = new Date().toISOString()
  const fresh: Account = { userEmail: user, startingCapital: DEFAULT_CAPITAL, cash: DEFAULT_CAPITAL, createdAt: now, updatedAt: now }
  await db.insert(guidancePtAccount).values(fresh).onConflictDoNothing()
  return fresh
}

export async function adjustCash(user: string, delta: number): Promise<void> {
  await db
    .update(guidancePtAccount)
    .set({ cash: sql`${guidancePtAccount.cash} + ${delta}`, updatedAt: new Date().toISOString() })
    .where(eq(guidancePtAccount.userEmail, user))
}

/** Wipe the user's positions and restart their account with the given mock capital. */
export async function resetAccount(user: string, capital: number): Promise<void> {
  const now = new Date().toISOString()
  await db.delete(guidancePtPositions).where(eq(guidancePtPositions.userEmail, user))
  await db
    .insert(guidancePtAccount)
    .values({ userEmail: user, startingCapital: capital, cash: capital, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: guidancePtAccount.userEmail, set: { startingCapital: capital, cash: capital, updatedAt: now } })
}

// ——— positions ———

export interface PositionRow {
  id: number
  userEmail: string
  symbol: string
  qty: number
  entryPrice: number
  entryDate: string
  placedAt: string
  stopLoss: number | null
  target: number | null
  tierAtEntry: string | null
  scoreAtEntry: number | null
  notes: string | null
  status: string
  exitPrice: number | null
  exitDate: string | null
  exitReason: string | null
  closedAt: string | null
}

/** Open positions — one user's, or (for the daily stop sweep) every user's. */
export async function openPositions(user?: string): Promise<PositionRow[]> {
  const where = user ? and(eq(guidancePtPositions.status, 'open'), eq(guidancePtPositions.userEmail, user)) : eq(guidancePtPositions.status, 'open')
  return db.select().from(guidancePtPositions).where(where).orderBy(asc(guidancePtPositions.entryDate), asc(guidancePtPositions.id))
}

export async function closedPositions(user: string, limit = 200): Promise<PositionRow[]> {
  return db
    .select()
    .from(guidancePtPositions)
    .where(and(eq(guidancePtPositions.status, 'closed'), eq(guidancePtPositions.userEmail, user)))
    .orderBy(desc(guidancePtPositions.closedAt))
    .limit(limit)
}

export async function getPosition(id: number): Promise<PositionRow | null> {
  const rows = await db.select().from(guidancePtPositions).where(eq(guidancePtPositions.id, id)).limit(1)
  return rows[0] ?? null
}

export async function insertPosition(p: Omit<PositionRow, 'id' | 'status' | 'exitPrice' | 'exitDate' | 'exitReason' | 'closedAt'>): Promise<number> {
  const rows = await db.insert(guidancePtPositions).values(p).returning({ id: guidancePtPositions.id })
  return rows[0].id
}

export async function setStops(id: number, stopLoss: number | null, target: number | null): Promise<void> {
  await db.update(guidancePtPositions).set({ stopLoss, target }).where(eq(guidancePtPositions.id, id))
}

export async function setQty(id: number, qty: number): Promise<void> {
  await db.update(guidancePtPositions).set({ qty }).where(eq(guidancePtPositions.id, id))
}

export async function markClosed(id: number, exit: { exitPrice: number; exitDate: string; exitReason: string }): Promise<void> {
  await db
    .update(guidancePtPositions)
    .set({ status: 'closed', exitPrice: exit.exitPrice, exitDate: exit.exitDate, exitReason: exit.exitReason, closedAt: new Date().toISOString() })
    .where(eq(guidancePtPositions.id, id))
}

/** A closed copy of part of a lot (partial sell) — keeps the original lot's entry facts. */
export async function insertClosedLot(src: PositionRow, qty: number, exit: { exitPrice: number; exitDate: string; exitReason: string }): Promise<void> {
  await db.insert(guidancePtPositions).values({
    userEmail: src.userEmail,
    symbol: src.symbol,
    qty,
    entryPrice: src.entryPrice,
    entryDate: src.entryDate,
    placedAt: src.placedAt,
    stopLoss: src.stopLoss,
    target: src.target,
    tierAtEntry: src.tierAtEntry,
    scoreAtEntry: src.scoreAtEntry,
    notes: src.notes,
    status: 'closed',
    exitPrice: exit.exitPrice,
    exitDate: exit.exitDate,
    exitReason: exit.exitReason,
    closedAt: new Date().toISOString(),
  })
}

/** Latest stored guidance signal snapshot for a symbol — records what the desk said at entry. */
export async function latestSnapshot(symbol: string): Promise<{ tier: string | null; score: number | null } | null> {
  const rows = await db
    .select({ tier: guidanceSnapshots.tier, score: guidanceSnapshots.score })
    .from(guidanceSnapshots)
    .where(eq(guidanceSnapshots.symbol, symbol))
    .orderBy(desc(guidanceSnapshots.asOf))
    .limit(1)
  return rows[0] ?? null
}
