// Repository: guidance_users (in-app access grants) + guidance_seen_users (the
// signed-in visitor ledger the admin panel reads its "pending approval" list from).
import { eq, desc, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceUsers, guidanceSeenUsers } from '../db/schema'

export interface GuidanceUser {
  userEmail: string
  addedBy: string
  addedAt: string
}

export async function list(): Promise<GuidanceUser[]> {
  return db.select().from(guidanceUsers).orderBy(asc(guidanceUsers.addedAt))
}

export async function has(email: string): Promise<boolean> {
  const rows = await db.select({ userEmail: guidanceUsers.userEmail }).from(guidanceUsers).where(eq(guidanceUsers.userEmail, email)).limit(1)
  return rows.length > 0
}

export async function add(email: string, addedBy: string): Promise<void> {
  await db.insert(guidanceUsers).values({ userEmail: email, addedBy, addedAt: new Date().toISOString() }).onConflictDoNothing()
}

export async function remove(email: string): Promise<void> {
  await db.delete(guidanceUsers).where(eq(guidanceUsers.userEmail, email))
}

// ——— signed-in visitor ledger ———

export interface SeenUser {
  userEmail: string
  firstSeen: string
  lastSeen: string
}

/** Record that this (verified) email was seen logged in just now. Fire-and-forget. */
export async function touchSeen(email: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .insert(guidanceSeenUsers)
    .values({ userEmail: email, firstSeen: now, lastSeen: now })
    .onConflictDoUpdate({ target: guidanceSeenUsers.userEmail, set: { lastSeen: sql`excluded.last_seen` } })
}

export async function listSeen(): Promise<SeenUser[]> {
  return db.select().from(guidanceSeenUsers).orderBy(desc(guidanceSeenUsers.lastSeen))
}
