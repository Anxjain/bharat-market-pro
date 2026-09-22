// CLI:
//   npm run ulip                          run all 8 active insurers for 2026-05
//   npm run ulip -- kotak 2026-04         one insurer, one month
//   npm run ulip -- kotak --months 2026-03,2026-04,2026-05   backfill (gaps recorded)
//   npm run ulip -- --status              print freshness only (no fetch)
//   add --force to re-process an already-stored month
import '../load-env'
import { pool } from '../db/client'
import { ensureSchema } from '../db/migrate'
import { runInsurerMonth } from './pipeline'
import { ADAPTERS } from './adapters'
import { freshness, formatFreshness } from './freshness'

/** Previous calendar month (YYYY-MM) — the sensible default target, not a hardcoded month
 *  (so `npm run ulip` in July processes June, not a stale literal) (M-U9). */
function defaultMonth(): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function main() {
  await ensureSchema()

  const args = process.argv.slice(2)
  const statusOnly = args.includes('--status')
  const force = args.includes('--force')
  const monthsArg = args.find((a) => a.startsWith('--months='))?.split('=')[1]
    ?? (args.includes('--months') ? args[args.indexOf('--months') + 1] : undefined)
  const single = args.find((a) => /^\d{4}-\d{2}$/.test(a))
  const months = monthsArg ? monthsArg.split(',').map((s) => s.trim()) : [single ?? defaultMonth()]
  const ids = args.filter((a) => !a.startsWith('--') && !/^\d{4}-\d{2}$/.test(a) && a !== monthsArg)
  const targets = ids.length ? ids : Object.keys(ADAPTERS)

  if (!statusOnly) {
    console.log(`[ulip] run — months [${months.join(', ')}] — insurers: ${targets.join(', ')}${force ? ' (force)' : ''}`)
    const summaries = []
    for (const id of targets) {
      for (const month of months) {
        // Per-insurer isolation: one insurer's failure (bad PDF, store error,
        // network) must not abort the whole batch — log it and keep going.
        try {
          summaries.push(await runInsurerMonth(id, month, { force }))
        } catch (e) {
          console.error(`[ulip] ${id} ${month} FAILED: ${(e as Error).message}`)
        }
      }
    }
    console.log('\n[ulip] ===== run summary =====')
    for (const s of summaries) {
      if (s.alreadyHad) {
        console.log(`  ${s.name} (${s.insurer}) ${s.month}: already present — skipped`)
      } else if (s.archived === 0) {
        console.log(`  ${s.name} (${s.insurer}) ${s.month}: GAP — no source archived (no reference / live fetch blocked)`)
      } else {
        console.log(
          `  ${s.name} (${s.insurer}) ${s.month}: archived ${s.archived}, stored ${s.stored} ` +
            `(clean ${s.byStatus.clean}, unverified ${s.byStatus.suspicious}, quarantined ${s.byStatus.failed}); ` +
            `unmatched holdings ${s.unmatchedHoldings}`,
        )
      }
    }
  }

  console.log('\n[ulip] ===== freshness =====')
  console.log(formatFreshness(await freshness()))
}

if (process.argv[1]?.endsWith('run.ts')) {
  main()
    .catch((e) => {
      console.error('[ulip] run failed:', e)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
