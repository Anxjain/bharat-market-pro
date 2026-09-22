// Repository: listed-insurer KPIs (real, sourced). Low-volume, quarterly.
import { db } from '../db/client'
import { insurerKpis } from '../db/schema'

export type InsurerKpiRow = typeof insurerKpis.$inferInsert

export async function list(): Promise<(typeof insurerKpis.$inferSelect)[]> {
  return db.select().from(insurerKpis)
}

export async function upsertMany(rows: InsurerKpiRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(insurerKpis)
    .values(rows)
    .onConflictDoUpdate({
      target: insurerKpis.symbol,
      set: {
        type: sqlExcluded('type'),
        vnbMarginPct: sqlExcluded('vnb_margin_pct'),
        solvencyRatio: sqlExcluded('solvency_ratio'),
        persistency13mPct: sqlExcluded('persistency_13m_pct'),
        combinedRatioPct: sqlExcluded('combined_ratio_pct'),
        apeGrowthPct: sqlExcluded('ape_growth_pct'),
        embeddedValueCr: sqlExcluded('embedded_value_cr'),
        marketSharePct: sqlExcluded('market_share_pct'),
        period: sqlExcluded('period'),
        sourceUrl: sqlExcluded('source_url'),
        updatedAt: sqlExcluded('updated_at'),
      },
    })
  return rows.length
}

// Small helper so the upsert set reads cleanly (excluded.<col>).
import { sql } from 'drizzle-orm'
function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`)
}
