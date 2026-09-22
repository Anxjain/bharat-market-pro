// Backfill deep daily price history for the guidance base-rate engine.
//
//   npm run guidance:backfill            -> just the watchlist symbols
//   npm run guidance:backfill -- --all   -> the entire NIFTY-500 instruments universe
//   npm run guidance:backfill -- --force -> refetch even if depth already present
//
// Yahoo serves the full multi-year daily series per `.NS` symbol, so this gives the
// engine real statistical power (years of comparable setups) instead of the ~98-day
// live ingest. Polite delay between symbols; resumable (skips already-deep symbols).
import '../load-env'
import { ensureHistory } from './history'
import * as watchRepo from '../repositories/guidanceWatchlist'
import { listSymbolName } from '../repositories/instruments'
import { pool } from '../db/client'

async function main(): Promise<void> {
  const all = process.argv.includes('--all')
  const force = process.argv.includes('--force')
  const symbols = all
    ? (await listSymbolName()).map((r) => r.symbol)
    : (await watchRepo.list(true)).map((w) => w.symbol)

  if (symbols.length === 0) {
    console.log('[guidance:backfill] no symbols (seed the watchlist first, or pass --all).')
    await pool.end()
    return
  }

  console.log(`[guidance:backfill] ${symbols.length} symbols${all ? ' (full universe)' : ''}${force ? ' (force)' : ''}`)
  let ok = 0
  for (const s of symbols) {
    try {
      const n = await ensureHistory(s, { force })
      ok++
      console.log(`  ${s}: ${n} rows`)
    } catch (e) {
      console.warn(`  ${s}: failed — ${(e as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, 400)) // be polite to Yahoo
  }
  console.log(`[guidance:backfill] done — ${ok}/${symbols.length} symbols`)
  await pool.end()
}

main().catch((e) => {
  console.error('[guidance:backfill] fatal:', e)
  process.exit(1)
})
