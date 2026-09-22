// Repository: guidance_labels — forward outcomes per (symbol, date). The grading joins
// live here too: label rows × signal snapshots = "did our calls beat the index".
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { guidanceLabels } from '../db/schema'

export interface LabelRow {
  symbol: string
  date: string
  r5: number | null
  r20: number | null
  r60: number | null
  x5: number | null
  x20: number | null
  x60: number | null
}

export async function upsertMany(rows: LabelRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const computedAt = new Date().toISOString()
  const CHUNK = 2000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, computedAt }))
    await db
      .insert(guidanceLabels)
      .values(chunk)
      .onConflictDoUpdate({
        target: [guidanceLabels.symbol, guidanceLabels.date],
        set: {
          r5: sql`excluded.r5`,
          r20: sql`excluded.r20`,
          r60: sql`excluded.r60`,
          x5: sql`excluded.x5`,
          x20: sql`excluded.x20`,
          x60: sql`excluded.x60`,
          computedAt: sql`excluded.computed_at`,
        },
      })
  }
  return rows.length
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(guidanceLabels)
  return rows[0]?.n ?? 0
}

export interface TierGrade {
  tier: string
  n: number
  avgR20: number | null
  avgX20: number | null
  hitX20: number | null // % of calls that beat the index over 20 sessions
  avgX60: number | null
  hitX60: number | null
  since: string | null
}

/** Grade every DISTINCT (symbol, day, tier) call the desk ever snapshotted against the
 *  measured forward outcomes. Excess (x*) columns are the honest read: beating the
 *  index, not just going up in a bull market. */
export async function gradeTiers(): Promise<TierGrade[]> {
  const res = await db.execute(sql`
    SELECT s.tier,
           count(*)::int AS n,
           round(avg(l.r20)::numeric, 2) AS avg_r20,
           round(avg(l.x20)::numeric, 2) AS avg_x20,
           round((avg((l.x20 > 0)::int) * 100)::numeric, 1) AS hit_x20,
           round(avg(l.x60)::numeric, 2) AS avg_x60,
           round((avg((l.x60 > 0)::int) * 100)::numeric, 1) AS hit_x60,
           min(s.data_date) AS since
    FROM (SELECT DISTINCT symbol, data_date, tier FROM guidance_snapshots WHERE tier IS NOT NULL AND data_date IS NOT NULL) s
    JOIN guidance_labels l ON l.symbol = s.symbol AND l.date = s.data_date
    WHERE l.x20 IS NOT NULL
    GROUP BY s.tier
    ORDER BY avg_x20 DESC NULLS LAST
  `)
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    tier: String(r.tier),
    n: Number(r.n),
    avgR20: r.avg_r20 == null ? null : Number(r.avg_r20),
    avgX20: r.avg_x20 == null ? null : Number(r.avg_x20),
    hitX20: r.hit_x20 == null ? null : Number(r.hit_x20),
    avgX60: r.avg_x60 == null ? null : Number(r.avg_x60),
    hitX60: r.hit_x60 == null ? null : Number(r.hit_x60),
    since: r.since == null ? null : String(r.since),
  }))
}
