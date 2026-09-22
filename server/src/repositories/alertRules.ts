// Repository: alert rules + hits (the 9.7 rule-based alerts engine).
// Separate from repositories/alerts.ts (simple live-quote price alerts) on purpose —
// rules are evaluated nightly against the bhavcopy store, not against live quotes.
import { eq, desc, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { alertRules, alertRuleHits } from '../db/schema'

export interface RuleRow {
  id: number
  name: string
  enabled: boolean
  conditions: unknown
  createdAt: string
}

export interface HitRow {
  id: number
  ruleId: number
  symbol: string
  date: string
  detail: unknown
  notified: boolean
  createdAt: string
}

export async function listRules(): Promise<RuleRow[]> {
  return db.select().from(alertRules).orderBy(desc(alertRules.id))
}

export async function enabledRules(): Promise<RuleRow[]> {
  return db.select().from(alertRules).where(eq(alertRules.enabled, true)).orderBy(desc(alertRules.id))
}

export async function insertRule(name: string, conditions: unknown, createdAt: string): Promise<RuleRow> {
  const [row] = await db.insert(alertRules).values({ name, conditions, createdAt }).returning()
  return row
}

export async function setEnabled(id: number, enabled: boolean): Promise<void> {
  await db.update(alertRules).set({ enabled }).where(eq(alertRules.id, id))
}

/** Delete a rule AND its hits (no FK cascade — hits are ours to clean up). */
export async function removeRule(id: number): Promise<void> {
  await db.delete(alertRuleHits).where(eq(alertRuleHits.ruleId, id))
  await db.delete(alertRules).where(eq(alertRules.id, id))
}

/** Insert hits idempotently (unique on rule+symbol+date). Returns only the rows
 *  that were actually NEW this run — re-runs return []. */
export async function insertHits(
  rows: { ruleId: number; symbol: string; date: string; detail: unknown; createdAt: string }[],
): Promise<HitRow[]> {
  if (rows.length === 0) return []
  return db
    .insert(alertRuleHits)
    .values(rows)
    .onConflictDoNothing({ target: [alertRuleHits.ruleId, alertRuleHits.symbol, alertRuleHits.date] })
    .returning()
}

export async function recentHits(limit: number): Promise<HitRow[]> {
  return db.select().from(alertRuleHits).orderBy(desc(alertRuleHits.id)).limit(limit)
}

/** Hits not yet delivered by email (capped — an SMTP outage must not build an
 *  unbounded backlog that floods the first successful send). */
export async function unnotified(limit: number): Promise<HitRow[]> {
  return db.select().from(alertRuleHits).where(eq(alertRuleHits.notified, false)).orderBy(desc(alertRuleHits.id)).limit(limit)
}

export async function markNotified(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await db.update(alertRuleHits).set({ notified: true }).where(inArray(alertRuleHits.id, ids))
}
