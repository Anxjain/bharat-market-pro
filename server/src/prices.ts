// Real-price query layer over Postgres (filled by `npm run ingest`).
// Returns the frontend's Candle shape; computes SMA(20) server-side.
// All SQL lives in the repositories; this module shapes the API responses.

import * as pricesRepo from './repositories/prices'
import * as indexRepo from './repositories/indexPrices'
import * as instrumentsRepo from './repositories/instruments'
import { getMeta } from './repositories/meta'

export interface CandleRow {
  date: string
  o: number
  h: number
  l: number
  c: number
  v: number
  sma?: number
}

function withSma(rows: CandleRow[]): CandleRow[] {
  for (let i = 19; i < rows.length; i++) {
    const win = rows.slice(i - 19, i + 1)
    rows[i].sma = Math.round((win.reduce((a, k) => a + k.c, 0) / 20) * 100) / 100
  }
  return rows
}

export async function getEquityCandles(symbol: string): Promise<CandleRow[]> {
  const rows = await pricesRepo.equityRows(symbol.toUpperCase())
  const candles: CandleRow[] = rows.map((r) => ({ date: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }))
  return withSma(candles)
}

export async function getIndexCandles(name: string): Promise<CandleRow[]> {
  const rows = await indexRepo.indexRows(name)
  return withSma(rows.map((r) => ({ date: r.date, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })))
}

export interface UniverseRow {
  symbol: string
  name: string
  industry: string
  domain: string | null
  close: number | null
  prevClose: number | null
  changePct: number | null
}

/** Full NIFTY 500 universe with latest close + day change from the last two sessions. */
export async function getUniverse(): Promise<{ asOf: string | null; rows: UniverseRow[] }> {
  const dates = await pricesRepo.distinctRecentDates(2)
  // M-B14: with no ingested prices the join on empty date strings would still return
  // every instrument (null closes) and the caller would mislabel it source:'real'.
  // Return an empty set so /api/universe honestly reports source:'mock'.
  if (dates.length === 0) return { asOf: null, rows: [] }
  const last = dates[0] ?? ''
  const prev = dates[1] ?? ''
  const rows = await pricesRepo.universe(last, prev)
  return {
    asOf: dates[0] ?? null,
    rows: rows.map((r) => ({
      ...r,
      changePct:
        r.close != null && r.prevClose != null && r.prevClose !== 0
          ? Math.round(((r.close - r.prevClose) / r.prevClose) * 10000) / 100
          : null,
    })),
  }
}

export async function priceStoreStatus() {
  const [pricesN, indicesN, instrumentsN, lastIngest] = await Promise.all([
    pricesRepo.count(),
    indexRepo.count(),
    instrumentsRepo.count(),
    getMeta('lastIngest'),
  ])
  return { prices: pricesN, indices: indicesN, instruments: instrumentsN, lastIngest }
}
