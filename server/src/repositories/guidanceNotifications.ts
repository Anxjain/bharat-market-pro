// Repository: guidance_notifications — per-user sell/risk advisories on paper positions.
import { and, eq, desc, gte, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceNotifications } from '../db/schema'

export interface NotificationRow {
  id: number
  userEmail: string
  positionId: number | null
  symbol: string
  kind: string
  severity: string
  title: string
  body: string
  fact: string | null
  createdAt: string
  readAt: string | null
}

export async function listFor(user: string, limit = 100): Promise<NotificationRow[]> {
  return db
    .select()
    .from(guidanceNotifications)
    .where(eq(guidanceNotifications.userEmail, user))
    .orderBy(desc(guidanceNotifications.createdAt))
    .limit(limit)
}

export async function unreadCount(user: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(guidanceNotifications)
    .where(and(eq(guidanceNotifications.userEmail, user), isNull(guidanceNotifications.readAt)))
  return rows[0]?.n ?? 0
}

export async function insert(n: Omit<NotificationRow, 'id' | 'createdAt' | 'readAt'>): Promise<void> {
  await db.insert(guidanceNotifications).values({ ...n, createdAt: new Date().toISOString() })
}

/** Dedupe guard: has this (user, position, kind) fired within the last `days`?
 *  Without this, a position sitting in drawdown would re-alert every single evening. */
export async function firedRecently(user: string, positionId: number | null, kind: string, days: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString()
  const rows = await db
    .select({ id: guidanceNotifications.id })
    .from(guidanceNotifications)
    .where(
      and(
        eq(guidanceNotifications.userEmail, user),
        positionId == null ? isNull(guidanceNotifications.positionId) : eq(guidanceNotifications.positionId, positionId),
        eq(guidanceNotifications.kind, kind),
        gte(guidanceNotifications.createdAt, cutoff),
      ),
    )
    .limit(1)
  return rows.length > 0
}

export async function markRead(user: string, id: number): Promise<void> {
  await db
    .update(guidanceNotifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(guidanceNotifications.id, id), eq(guidanceNotifications.userEmail, user)))
}

export async function markAllRead(user: string): Promise<void> {
  await db
    .update(guidanceNotifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(guidanceNotifications.userEmail, user), isNull(guidanceNotifications.readAt)))
}
