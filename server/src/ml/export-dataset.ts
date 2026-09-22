// ML dataset export — features × labels for the cross-sectional ranker.
//
//   npm run ml:export                          -> server/../scripts/ml/out/dataset.csv
//   npm run ml:export -- --since 2019-01-01 --every 5
//
// One row per (symbol, sampled session): point-in-time PRICE features computed from the
// deep history store, joined to the measured forward outcomes (guidance_labels). The
// target is x20/x60 — EXCESS return vs NIFTY — because predicting "up in a bull market"
// is worthless. Sampling every Nth session keeps the file tractable without losing the
// cross-section. NO fundamentals here yet (we only have current-snapshot fundamentals;
// using them historically would be look-ahead leakage — the #1 way finance ML lies).
import '../load-env'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as histRepo from '../repositories/guidancePriceHistory'
import * as instrumentsRepo from '../repositories/instruments'
import { db } from '../db/client'
import { pool } from '../db/client'
import { guidanceLabels } from '../db/schema'
import { eq } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, '..', '..', '..', 'scripts', 'ml', 'out')

const round4 = (n: number) => Math.round(n * 10000) / 10000

function ret(closes: number[], i: number, n: number): number | null {
  const a = closes[i - n]
  return a != null && a > 0 ? round4(((closes[i] - a) / a) * 100) : null
}

function vol(closes: number[], i: number, n: number): number | null {
  if (i - n < 0) return null
  const rets: number[] = []
  for (let k = i - n + 1; k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
  return round4(Math.sqrt(varr) * Math.sqrt(252) * 100)
}

function rsi14(closes: number[], i: number): number | null {
  if (i < 14) return null
  let gain = 0
  let loss = 0
  for (let k = i - 13; k <= i; k++) {
    const d = closes[k] - closes[k - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  if (gain + loss === 0) return 50
  return round4(100 - 100 / (1 + gain / (loss || 1e-9)))
}

async function main(): Promise<void> {
  const argSince = process.argv.indexOf('--since')
  const argEvery = process.argv.indexOf('--every')
  const since = argSince > -1 ? process.argv[argSince + 1] : '2019-01-01'
  const every = argEvery > -1 ? Math.max(1, Number(process.argv[argEvery + 1])) : 5

  const symbols = await instrumentsRepo.listSymbols()
  const header = 'symbol,date,m12,m6,m3,m1,vol60,dd_52w,off_low_52w,rsi14,x20,x60,r20,r60'
  const lines: string[] = [header]
  let done = 0

  for (const sym of symbols) {
    const candles = await histRepo.candlesAsc(sym).catch(() => [])
    if (candles.length < 260) { done++; continue }
    const closes = candles.map((c) => c.close)
    // labels for this symbol, keyed by date (one query per symbol, not per row)
    const labelRows = await db.select().from(guidanceLabels).where(eq(guidanceLabels.symbol, sym))
    const labels = new Map(labelRows.map((l) => [l.date, l]))

    for (let i = 260; i < candles.length; i += every) {
      const date = candles[i].date
      if (date < since) continue
      const l = labels.get(date)
      if (!l || (l.x20 == null && l.x60 == null)) continue // no matured outcome = no training row
      const hi52 = Math.max(...closes.slice(i - 251, i + 1))
      const lo52 = Math.min(...closes.slice(i - 251, i + 1))
      const row = [
        sym,
        date,
        ret(closes, i, 252),
        ret(closes, i, 126),
        ret(closes, i, 63),
        ret(closes, i, 21),
        vol(closes, i, 60),
        hi52 > 0 ? round4(((closes[i] - hi52) / hi52) * 100) : null,
        lo52 > 0 ? round4(((closes[i] - lo52) / lo52) * 100) : null,
        rsi14(closes, i),
        l.x20,
        l.x60,
        l.r20,
        l.r60,
      ]
      if (row.slice(2, 10).some((v) => v == null)) continue // incomplete features — drop, don't impute
      lines.push(row.join(','))
    }
    done++
    if (done % 100 === 0) console.log(`[ml:export] ${done}/${symbols.length} symbols, ${lines.length - 1} rows`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'dataset.csv')
  writeFileSync(out, lines.join('\n'))
  console.log(`[ml:export] wrote ${lines.length - 1} rows -> ${out}`)
  await pool.end()
}

main().catch((e) => { console.error('[ml:export] fatal:', e); process.exit(1) })
