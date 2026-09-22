// Repository: guidance config (tunable factor weights, thresholds, tier cutoffs).
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceConfig } from '../db/schema'

export async function get<T = unknown>(key: string): Promise<T | null> {
  const rows = await db.select({ value: guidanceConfig.value }).from(guidanceConfig).where(eq(guidanceConfig.key, key)).limit(1)
  return (rows[0]?.value as T) ?? null
}

export async function set(key: string, value: unknown): Promise<void> {
  await db
    .insert(guidanceConfig)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: guidanceConfig.key, set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` } })
}

export async function getAll(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(guidanceConfig)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}
