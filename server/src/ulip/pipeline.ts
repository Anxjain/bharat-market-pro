// ULIP pipeline driver: fetch -> archive -> extract -> validate/normalize -> store
// for one insurer+month. Idempotent: if funds for (insurer, month) already exist
// it reports "already have insurer X month Y" and does no work (unless force).
import { getAdapter } from './adapters'
import { archive } from './archive'
import { extract } from './extract'
import { store } from './store'
import { buildAliasesFromInstruments, seedManualAliases } from './seed'
import * as insurersRepo from '../repositories/insurers'
import * as sourcesRepo from '../repositories/sources'
import * as fundHoldingsRepo from '../repositories/fundHoldings'

export interface PipelineSummary {
  insurer: string
  name: string
  month: string
  alreadyHad: boolean
  archived: number
  extractedVia: string[]
  stored: number
  byStatus: { clean: number; suspicious: number; failed: number }
  failedSfins: string[]
  unmatchedHoldings: number
}

export async function runInsurerMonth(
  adapterId: string,
  month: string,
  opts: { force?: boolean } = {},
): Promise<PipelineSummary> {
  const adapter = getAdapter(adapterId)

  // Register the insurer + grow/seed the alias map (idempotent).
  await insurersRepo.upsert({
    irdaiCode: adapter.irdaiCode,
    name: adapter.name,
    website: adapter.website,
    adapterId: adapter.id,
    status: 'active',
  })
  const fromUniverse = await buildAliasesFromInstruments()
  await seedManualAliases()

  const summary: PipelineSummary = {
    insurer: adapter.irdaiCode,
    name: adapter.name,
    month,
    alreadyHad: false,
    archived: 0,
    extractedVia: [],
    stored: 0,
    byStatus: { clean: 0, suspicious: 0, failed: 0 },
    failedSfins: [],
    unmatchedHoldings: 0,
  }

  // Doc-aware idempotency gate + per-doc isolation. A partial month (e.g. doc 5 of 23 threw)
  // must NOT freeze the remaining docs: we (a) skip only the docs whose sources.parse_status
  // is already 'stored' (not a blanket insurer-level fund-count skip), and (b) wrap each doc
  // in try/catch so one bad doc doesn't abort the rest (H-8).
  const docs = adapter.docs(month)
  let skipped = 0
  for (const doc of docs) {
    try {
      if (!opts.force) {
        const src = await sourcesRepo.get(adapter.irdaiCode, month, doc.kind)
        if (src?.parseStatus === 'stored') {
          skipped++
          console.log(`[ulip] ${adapter.id} ${doc.kind} ${month}: already stored — skipping`)
          continue
        }
      }

      const a = await archive(adapter, month, doc, { force: opts.force })
      if (!a) continue
      summary.archived++

      const ex = await extract(adapter.id, doc.kind, a.rawPath, month)
      summary.extractedVia.push(ex.via)
      const res = await store(adapter, month, ex.funds)
      summary.stored += res.stored
      summary.byStatus.clean += res.byStatus.clean
      summary.byStatus.suspicious += res.byStatus.suspicious
      summary.byStatus.failed += res.byStatus.failed
      summary.failedSfins.push(...res.failedSfins)

      // AUDIT FIX (2026-07-14): `res.stored` counts EVERY written fund, including
      // quarantined (failed-validation) ones. Marking parse_status 'stored' on an
      // all-quarantined run permanently blocks re-ingest (the idempotency gate skips
      // 'stored' docs). Only call it stored when at least one usable (clean/suspicious)
      // fund landed — otherwise 'failed', so the next run retries it.
      const usable = res.byStatus.clean + res.byStatus.suspicious
      await sourcesRepo.setParseStatus(adapter.irdaiCode, month, doc.kind, usable > 0 ? 'stored' : 'failed')
      console.log(
        `[ulip] ${adapter.id} ${doc.kind}: archived via ${a.via}, extracted via ${ex.via}, stored ${res.stored} ` +
          `(clean ${res.byStatus.clean}, suspicious ${res.byStatus.suspicious}, quarantined ${res.byStatus.failed})` +
          (res.failedSfins.length ? ` — quarantined: ${res.failedSfins.join(', ')}` : ''),
      )
    } catch (e) {
      // Mirror run.ts per-insurer isolation at the doc level.
      console.error(`[ulip] ${adapter.id} ${doc.kind} ${month} FAILED: ${(e as Error).message} — continuing with remaining docs`)
    }
  }
  if (docs.length > 0 && skipped === docs.length) {
    summary.alreadyHad = true
    console.log(`[ulip] already have insurer ${adapter.name} (${adapter.irdaiCode}) month ${month} — all ${docs.length} docs stored, skipping`)
  }

  // Surface holdings that didn't resolve to an NSE symbol (coverage gaps).
  const unmatched = (await fundHoldingsRepo.unmatched(month)).filter((h) => h.sfin.slice(-3) === adapter.irdaiCode)
  summary.unmatchedHoldings = unmatched.length
  console.log(
    `[ulip] ${adapter.id}: aliases from universe=${fromUniverse}, unmatched holdings this month=${unmatched.length}` +
      (unmatched.length ? ` (e.g. ${unmatched.slice(0, 5).map((h) => h.security).join('; ')})` : ''),
  )

  return summary
}
