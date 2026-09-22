// Batch fact-sheet warmer - populates a screener.in fact sheet (and the company
// logo domain) for EVERY instrument in the NIFTY 500 universe, not a curated few.
//
// Run: npm run warm                  (refresh stale/missing; default)
//      npm run warm -- --all         (force-refresh every symbol, ignoring TTL)
//      npm run warm -- --limit 50    (cap how many are fetched this run)
//
// Polite + resumable: fresh sheets (<24h) are skipped unless --all, and each miss
// is throttled. getFactSheet() does the scrape, caches the sheet, and writes the
// logo domain to instruments. Safe to re-run; it only fetches what's stale.

import { pool } from '../db/client'
import { ensureSchema } from '../db/migrate'
import { getFactSheet } from '../fact-sheet'
import { listSymbolName, countWithDomain } from '../repositories/instruments'
import * as factSheetsRepo from '../repositories/factSheets'

const TTL_MS = 24 * 60 * 60 * 1000
const THROTTLE_MS = 1200 // ~1.2s between screener hits - be polite to the source

async function main() {
  await ensureSchema()

  const argv = process.argv.slice(2)
  const force = argv.includes('--all')
  const limArg = argv.indexOf('--limit')
  const limit = limArg > -1 ? Number(argv[limArg + 1]) : Infinity

  const instruments = await listSymbolName()
  const fresh = new Map((await factSheetsRepo.freshList()).map((r) => [r.symbol, new Date(r.updatedAt).getTime()]))

  const now = Date.now()
  const pending = instruments.filter((i) => force || now - (fresh.get(i.symbol) ?? 0) >= TTL_MS).slice(0, limit)

  console.log(
    `[warm] ${instruments.length} instruments · ${instruments.length - pending.length} already fresh · ` +
      `fetching ${pending.length}${force ? ' (forced)' : ''}`,
  )

  let ok = 0, withLogo = 0, fail = 0
  for (let i = 0; i < pending.length; i++) {
    const { symbol } = pending[i]
    try {
      const sheet = await getFactSheet(symbol)
      if (sheet && sheet.ratios.length >= 4) {
        ok++
        if (sheet.domain) withLogo++
        console.log(`[warm] ${i + 1}/${pending.length} ${symbol} OK ${sheet.domain ?? '(no website)'}`)
      } else {
        fail++
        console.warn(`[warm] ${i + 1}/${pending.length} ${symbol} - no fact sheet`)
      }
    } catch (e) {
      fail++
      console.warn(`[warm] ${i + 1}/${pending.length} ${symbol} failed:`, (e as Error).message)
    }
    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS))
  }

  const domains = await countWithDomain()
  const sheets = await factSheetsRepo.count()
  console.log(
    `[warm] done - ${ok} ok (${withLogo} with logo), ${fail} missed this run · ` +
      `coverage: ${sheets}/${instruments.length} fact sheets, ${domains}/${instruments.length} logos`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
