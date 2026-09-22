// Deterministic (seeded) price-series generator.
// Seeded so charts are stable across reloads — no random flicker in demos.
// In Phase 2 this module is replaced by real OHLC history from a market data API.

export interface PricePoint {
  date: string
  price: number
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSymbol(symbol: string): number {
  let h = 0
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Anchor date for all mock data ("today" in the dataset). */
export const DATA_AS_OF = new Date('2026-06-11T15:30:00+05:30')

/**
 * Generate ~90 trading days of history ending at `endPrice`,
 * with drift/volatility derived from the symbol seed.
 */
export function generateHistory(symbol: string, endPrice: number, days = 90): PricePoint[] {
  const rand = mulberry32(hashSymbol(symbol))
  const drift = (rand() - 0.45) * 0.003 // slight per-stock bias
  const vol = 0.008 + rand() * 0.012 // daily volatility 0.8%–2%

  // Walk backwards from the end price so the series lands exactly on it.
  const points: PricePoint[] = []
  let price = endPrice
  const d = new Date(DATA_AS_OF)
  for (let i = 0; i < days; i++) {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1) // skip weekends
    points.push({ date: d.toISOString().slice(0, 10), price: Math.round(price * 100) / 100 })
    const shock = (rand() * 2 - 1) * vol
    price = price / (1 + drift + shock)
    d.setDate(d.getDate() - 1)
  }
  return points.reverse()
}

/** Last-n slice convenience for sparklines. */
export function lastN(points: PricePoint[], n: number): PricePoint[] {
  return points.slice(-n)
}

// ——— OHLC candles + volume, derived deterministically from the close series ———

export interface Candle {
  date: string
  o: number
  h: number
  l: number
  c: number
  v: number // volume (shares, arbitrary mock scale)
  sma?: number // 20-period simple moving average of closes
}

/** Build candles from a close-price series; wicks/volume are seeded per symbol+bar. */
export function deriveCandles(symbol: string, points: PricePoint[]): Candle[] {
  const rand = mulberry32(hashSymbol(symbol + ':ohlc'))
  const candles: Candle[] = points.map((p, i) => {
    const c = p.price
    const o = i === 0 ? c * (1 + (rand() - 0.5) * 0.01) : points[i - 1].price
    const hi = Math.max(o, c) * (1 + rand() * 0.006)
    const lo = Math.min(o, c) * (1 - rand() * 0.006)
    const v = Math.round(2_000_000 + rand() * 6_000_000 + Math.abs(c - o) * 90_000)
    return {
      date: p.date,
      o: Math.round(o * 100) / 100,
      h: Math.round(hi * 100) / 100,
      l: Math.round(lo * 100) / 100,
      c,
      v,
    }
  })
  // 20-bar SMA overlay
  for (let i = 19; i < candles.length; i++) {
    const win = candles.slice(i - 19, i + 1)
    candles[i].sma = Math.round((win.reduce((a, k) => a + k.c, 0) / 20) * 100) / 100
  }
  return candles
}
