// Repository: insurers (ULIP issuers, keyed by IRDAI code).
import { eq, asc, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { insurers } from '../db/schema'

export interface InsurerRow {
  irdaiCode: string
  name: string
  website: string | null
  adapterId: string
  status: string
}

export async function upsert(row: InsurerRow): Promise<void> {
  await db
    .insert(insurers)
    .values(row)
    .onConflictDoUpdate({
      target: insurers.irdaiCode,
      set: { name: sql`excluded.name`, website: sql`excluded.website`, adapterId: sql`excluded.adapter_id`, status: sql`excluded.status` },
    })
}

export async function get(irdaiCode: string): Promise<InsurerRow | null> {
  const rows = await db.select().from(insurers).where(eq(insurers.irdaiCode, irdaiCode)).limit(1)
  return rows[0] ?? null
}

export async function list(): Promise<InsurerRow[]> {
  return db.select().from(insurers).orderBy(asc(insurers.irdaiCode))
}
