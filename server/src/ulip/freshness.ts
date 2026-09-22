// Per-insurer freshness / backfill status: which months are archived, how many
// funds were stored, and the validation breakdown — so coverage and gaps are
// visible at a glance. Active insurers come from the adapter registry; parked
// insurers are listed as schema-ready placeholders.
import { ADAPTERS, PARKED_INSURERS } from './adapters'
import * as sourcesRepo from '../repositories/sources'
import * as fundsRepo from '../repositories/funds'

export interface MonthStatus {
  month: string
  parseStatus: string
  funds: number
  clean: number
  suspicious: number
  failed: number
}
export interface InsurerFreshness {
  code: string
  name: string
  status: 'active' | 'parked'
  latestStored: string | null
  months: MonthStatus[]
}

export async function freshness(): Promise<InsurerFreshness[]> {
  const out: InsurerFreshness[] = []
  // Month list is derived from the ACTUAL stored funds (not the sources/fetch table),
  // so backfilled months — and any insurer loaded without a fetch record — show up.
  const allMonths = await fundsRepo.distinctMonths() // newest first
  for (const a of Object.values(ADAPTERS)) {
    const srcs = await sourcesRepo.listByInsurer(a.irdaiCode) // parseStatus only, if present
    const ms: MonthStatus[] = []
    let latestStored: string | null = null
    for (const m of allMonths) {
      const funds = await fundsRepo.listByInsurerMonth(a.irdaiCode, m)
      if (funds.length === 0) continue // this insurer has no data for this month
      const clean = funds.filter((f) => f.status === 'clean').length
      const suspicious = funds.filter((f) => f.status === 'suspicious').length
      const failed = funds.filter((f) => f.status === 'failed').length
      const parseStatus = srcs.find((s) => s.month === m)?.parseStatus ?? 'stored'
      ms.push({ month: m, parseStatus, funds: funds.length, clean, suspicious, failed })
      if (!latestStored) latestStored = m
    }
    out.push({ code: a.irdaiCode, name: a.name, status: 'active', latestStored, months: ms })
  }
  for (const p of PARKED_INSURERS) {
    out.push({ code: p.irdaiCode, name: p.name, status: 'parked', latestStored: null, months: [] })
  }
  return out
}

/** Human-readable one-line-per-insurer freshness report. */
export function formatFreshness(rows: InsurerFreshness[]): string {
  const lines: string[] = []
  for (const r of rows) {
    if (r.status === 'parked') {
      lines.push(`  ${r.name} (${r.code}): PARKED (schema-ready, adapter not built)`)
      continue
    }
    if (r.months.length === 0) {
      lines.push(`  ${r.name} (${r.code}): pending (no archive yet)`)
      continue
    }
    const parts = r.months.map((m) => {
      if (m.funds > 0) {
        const extra = m.suspicious || m.failed ? ` [${m.suspicious} unverified, ${m.failed} quarantined]` : ''
        return `${m.month} OK (${m.funds} funds${extra})`
      }
      return `${m.month} archived (0 funds — extraction pending)`
    })
    lines.push(`  ${r.name} (${r.code}): latest ${r.latestStored ?? '—'} · ${parts.join(' · ')}`)
  }
  return lines.join('\n')
}
