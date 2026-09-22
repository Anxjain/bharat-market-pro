// Backfill loader: ingest LOCALLY-extracted fund JSON — the output of the
// deterministic extractors in server/extractors/, no LLM — through the EXISTING
// validate+normalize+store path, so a backfilled month is produced exactly the
// same way as a month ingested by the live pipeline.
//
//   npm run ulip:load -- <adapterId> <YYYY-MM> <json> [--force]
//
// (docs/samples/ has one such JSON file, to show the expected shape.)
//
// Idempotent-ish: store() upserts by (sfin, month). Load oldest->newest so each
// month sees its prior month for MoM/holding-drift validation context.
import '../load-env'
import { readFileSync } from 'node:fs'
import { pool } from '../db/client'
import { ensureSchema } from '../db/migrate'
import { getAdapter } from './adapters'
import { store } from './store'
import { ExtractionZ } from './types'
import { buildAliasesFromInstruments, seedManualAliases } from './seed'
import * as insurersRepo from '../repositories/insurers'
import * as fundsRepo from '../repositories/funds'

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const [id, jsonPath] = args.filter((a) => a !== '--force')
  if (!id || !jsonPath) {
    console.error('usage: backfillLoad <adapterId> <json> [--force]   (month is read from the JSON, derived from the PDF as-on date)')
    process.exit(1)
  }

  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const month: string = doc.month
  if (!/^\d{4}-\d{2}$/.test(month ?? '')) {
    console.error(`[backfill] ${jsonPath}: missing/invalid "month" (got ${JSON.stringify(month)}) — parser must derive it from the PDF as-on date`)
    process.exit(1)
  }

  await ensureSchema()
  const adapter = getAdapter(id)
  await insurersRepo.upsert({
    irdaiCode: adapter.irdaiCode, name: adapter.name, website: adapter.website,
    adapterId: adapter.id, status: 'active',
  })
  await buildAliasesFromInstruments()
  await seedManualAliases()

  const existing = await fundsRepo.countByInsurerMonth(adapter.irdaiCode, month)
  if (existing > 0 && !force) {
    console.log(`[backfill] ${id} ${month}: already has ${existing} funds — skipping (use --force to overwrite)`)
    return
  }

  const parsed = ExtractionZ.parse(doc)
  const res = await store(adapter, month, parsed.funds)
  console.log(
    `[backfill] ${id} ${month}: stored ${res.stored}/${parsed.funds.length} ` +
      `(clean ${res.byStatus.clean}, unverified ${res.byStatus.suspicious}, quarantined ${res.byStatus.failed})` +
      (res.failedSfins.length ? `\n  quarantined: ${res.failedSfins.join(', ')}` : ''),
  )
}

main().catch((e) => { console.error('[backfill] failed:', e); process.exitCode = 1 }).finally(() => pool.end())
