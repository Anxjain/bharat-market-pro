// Repository: security_aliases (security name -> NSE symbol map).
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { securityAliases } from '../db/schema'

export interface AliasRow {
  alias: string // lowercased security name
  symbol: string
}

export async function all(): Promise<AliasRow[]> {
  return db.select().from(securityAliases)
}

export async function upsertMany(rows: AliasRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(securityAliases)
    .values(rows)
    .onConflictDoUpdate({ target: securityAliases.alias, set: { symbol: sql`excluded.symbol` } })
  return rows.length
}
