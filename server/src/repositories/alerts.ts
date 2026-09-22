// Repository: alerts (price alerts).
import { and, eq, isNull, desc } from 'drizzle-orm'
import { db } from '../db/client'
import { alerts } from '../db/schema'

export interface AlertRow {
  id: number
  symbol: string
  condition: string
  price: number
  active: boolean
  createdAt: string
  triggeredAt: string | null
  triggerPrice: number | null
}

export async function listRows(symbol?: string): Promise<AlertRow[]> {
  const q = db.select().from(alerts)
  const rows = symbol
    ? await q.where(eq(alerts.symbol, symbol)).orderBy(desc(alerts.id))
    : await q.orderBy(desc(alerts.id))
  return rows
}

export async function insert(symbol: string, condition: 'above' | 'below', price: number, createdAt: string): Promise<AlertRow> {
  const [row] = await db.insert(alerts).values({ symbol, condition, price, createdAt }).returning()
  return row
}

export async function setActive(id: number, active: boolean): Promise<void> {
  await db.update(alerts).set({ active }).where(and(eq(alerts.id, id), isNull(alerts.triggeredAt)))
}

export async function remove(id: number): Promise<void> {
  await db.delete(alerts).where(eq(alerts.id, id))
}

export async function activeUntriggered(): Promise<AlertRow[]> {
  return db.select().from(alerts).where(and(eq(alerts.active, true), isNull(alerts.triggeredAt)))
}

export async function fire(id: number, triggerPrice: number, triggeredAt: string): Promise<void> {
  await db.update(alerts).set({ triggeredAt, triggerPrice, active: false }).where(eq(alerts.id, id))
}
