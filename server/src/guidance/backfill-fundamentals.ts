// Backfill the BUSINESS-QUALITY axis (guidance_fundamentals) for the guidance desk.
//
//   npm run guidance:backfill:fundamentals            -> watchlist + latest board symbols
//   npm run guidance:backfill:fundamentals -- --all   -> the entire NIFTY-500 universe (slow)
//   npm run guidance:backfill:fundamentals -- --force -> refetch even if recently cached
//
// Fundamentals are otherwise fetched LAZILY (on first signal view, then weekly-cached),
// so a fresh DB shows blank `biz` scores on the opportunity board until each name is
// opened. This warms the table up front from screener.in. Resumable + polite; safe to
// re-run (getFundamentals skips names refreshed within the last week unless --force).
import '../load-env'
import { getFundamentals, fetchFundamentals } from './fundamentals'
import * as fundRepo from '../repositories/guidanceFundamentals'
import * as watchRepo from '../repositories/guidanceWatchlist'
import * as boardRepo from '../repositories/guidanceBoard'
import { listSymbolName } from '../repositories/instruments'
import { pool } from '../db/client'
import type { Board } from './scan'

/** Default target = active watchlist ∪ symbols on the latest opportunity board. */
async function targetSymbols(all: boolean): Promise<string[]> {
  if (all) return (await listSymbolName()).map((r) => r.symbol)
  const set = new Set<string>()
  for (const w of await watchRepo.list(true)) set.add(w.symbol.toUpperCase())
  const board = await boardRepo.latest<Board>().catch(() => null)
  for (const o of board?.json?.opportunities ?? []) set.add(o.symbol.toUpperCase())
  return [...set]
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all')
  const force = process.argv.includes('--force')
  const symbols = await targetSymbols(all)
  if (symbols.length === 0) {
    console.log('[guidance:fundamentals] no symbols — seed the watchlist or run a scan first (or pass --all).')
    await pool.end()
    return
  }

  console.log(`[guidance:fundamentals] ${symbols.length} symbols${all ? ' (full universe)' : ''}${force ? ' (force)' : ''}`)
  let ok = 0
  let avoid = 0
  let missed = 0
  for (const s of symbols) {
    try {
      // --force bypasses the weekly cache with a direct fetch + explicit store.
      const f = force ? await fetchFundamentals(s) : await getFundamentals(s)
      if (force && f) {
        await fundRepo.set(s, f)
        await fundRepo.appendHistory(s, f.asOf, f).catch(() => {}) // M-G6: accumulate history
      }
      if (f) {
        ok++
        if (f.risk.forceAvoid) avoid++
        console.log(`  ${s}: ${f.qualityScore}/100 ${f.qualityTier}${f.risk.forceAvoid ? ' ⚠avoid' : ''}`)
      } else {
        missed++
        console.warn(`  ${s}: no fundamentals (screener miss)`)
      }
    } catch (e) {
      missed++
      console.warn(`  ${s}: failed — ${(e as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, 500)) // be polite to screener.in
  }
  console.log(`[guidance:fundamentals] done — ${ok}/${symbols.length} scored (${avoid} force-avoid, ${missed} missing)`)
  await pool.end()
}

main().catch((e) => {
  console.error('[guidance:fundamentals] fatal:', e)
  process.exit(1)
})
