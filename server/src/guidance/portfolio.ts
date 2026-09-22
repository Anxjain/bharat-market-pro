// Paper-trading engine (mock money, owner-only) — broker-app mechanics on real EOD data.
//
// Honesty rules (this is a measurement tool, not a fantasy):
//   • Fills happen at the LATEST NSE close (or an explicit price you type) — there is no
//     intraday feed, so "market buy" = last close, stated on the position.
//   • Stop-loss / target are evaluated on the real daily OHLC bars AFTER the entry date,
//     gap-aware like a real broker: gap through the level → filled at the OPEN (slippage
//     is real), otherwise at the level itself. If one bar touches both SL and target the
//     ambiguity is resolved AGAINST you (stop-loss wins) — never the flattering read.
//   • No brokerage/STT/stamp duty is charged (stated in the account note) — mock P&L
//     therefore reads slightly better than a real account would.
import * as repo from '../repositories/paperTrading'
import * as pricesRepo from '../repositories/prices'
import * as instrumentsRepo from '../repositories/instruments'
import { getQuotes } from '../quotes'
import { indexReturnPct } from './labels'

export interface Quote {
  price: number
  date: string
  prevClose: number | null
  live: boolean // true = Yahoo delayed (~15 min) quote; false = last EOD close
}

/** Live (~15-min delayed) quote first — so the portfolio actually MOVES during market
 *  hours — with the EOD store as the fallback (weekends, Yahoo hiccups). */
export async function latestQuote(symbol: string): Promise<Quote | null> {
  const [lq] = await getQuotes([symbol]).catch(() => [])
  if (lq) return { price: lq.price, date: lq.marketTime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10), prevClose: lq.prevClose, live: true }
  const rows = await pricesRepo.recentClosesDesc(symbol, 2)
  if (rows.length === 0) return null
  return { price: rows[0].close, date: rows[0].date, prevClose: rows[1]?.close ?? null, live: false }
}

/** Batched quotes for a symbol set (one Yahoo round-trip, per-symbol EOD fallback). */
async function quotesFor(symbols: string[]): Promise<Map<string, Quote | null>> {
  const unique = [...new Set(symbols)]
  const out = new Map<string, Quote | null>()
  const live = await getQuotes(unique).catch(() => [])
  for (const lq of live) {
    out.set(lq.key, { price: lq.price, date: lq.marketTime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10), prevClose: lq.prevClose, live: true })
  }
  for (const sym of unique) {
    if (out.has(sym)) continue
    const rows = await pricesRepo.recentClosesDesc(sym, 2)
    out.set(sym, rows.length ? { price: rows[0].close, date: rows[0].date, prevClose: rows[1]?.close ?? null, live: false } : null)
  }
  return out
}

// ——— order placement ———

export interface OrderInput {
  symbol: string
  qty: number
  price?: number // omit = fill at latest close
  stopLoss?: number
  target?: number
  notes?: string
}

export type OrderResult = { ok: true; id: number; fillPrice: number; fillDate: string } | { ok: false; error: string }

export async function placeOrder(user: string, input: OrderInput): Promise<OrderResult> {
  const symbol = input.symbol.toUpperCase().trim()
  const qty = Math.floor(input.qty)
  if (!symbol) return { ok: false, error: 'symbol required' }
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'quantity must be a positive whole number' }

  const q = await latestQuote(symbol)
  if (!q && input.price == null) return { ok: false, error: `no price data for ${symbol} — it isn't in the daily NSE store` }
  const fillPrice = input.price != null ? Number(input.price) : q!.price
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { ok: false, error: 'invalid price' }
  const fillDate = q?.date ?? new Date().toISOString().slice(0, 10)

  const sl = input.stopLoss != null ? Number(input.stopLoss) : null
  const tgt = input.target != null ? Number(input.target) : null
  if (sl != null && (!Number.isFinite(sl) || sl <= 0 || sl >= fillPrice)) return { ok: false, error: 'stop-loss must be below the buy price' }
  if (tgt != null && (!Number.isFinite(tgt) || tgt <= fillPrice)) return { ok: false, error: 'target must be above the buy price' }

  const cost = qty * fillPrice
  const account = await repo.getAccount(user)
  if (cost > account.cash + 1e-6) return { ok: false, error: `not enough mock cash — cost ₹${cost.toFixed(0)}, available ₹${account.cash.toFixed(0)}` }

  // Record what the desk said at entry (latest stored signal snapshot, if any) — this is
  // what makes "did the guidance actually work?" answerable later.
  const snap = await repo.latestSnapshot(symbol).catch(() => null)

  const id = await repo.insertPosition({
    userEmail: user,
    symbol,
    qty,
    entryPrice: fillPrice,
    entryDate: fillDate,
    placedAt: new Date().toISOString(),
    stopLoss: sl,
    target: tgt,
    tierAtEntry: snap?.tier ?? null,
    scoreAtEntry: snap?.score ?? null,
    notes: input.notes?.slice(0, 500) ?? null,
  })
  await repo.adjustCash(user, -cost)
  return { ok: true, id, fillPrice, fillDate }
}

// ——— closing (manual sell, full or partial) ———

export type CloseResult = { ok: true; exitPrice: number; exitDate: string; realizedPnl: number } | { ok: false; error: string }

export async function closePosition(user: string, id: number, opts: { qty?: number; price?: number } = {}): Promise<CloseResult> {
  const pos = await repo.getPosition(id)
  // Ownership check — another user's position id must read as nonexistent.
  if (!pos || pos.status !== 'open' || pos.userEmail !== user) return { ok: false, error: 'position not found or already closed' }
  const q = await latestQuote(pos.symbol)
  const exitPrice = opts.price != null ? Number(opts.price) : q?.price
  if (exitPrice == null || !Number.isFinite(exitPrice) || exitPrice <= 0) return { ok: false, error: 'no price available — pass an explicit price' }
  const exitDate = q?.date ?? new Date().toISOString().slice(0, 10)

  const sellQty = Math.floor(opts.qty ?? pos.qty)
  if (sellQty <= 0 || sellQty > pos.qty) return { ok: false, error: `quantity must be 1–${pos.qty}` }

  const exit = { exitPrice, exitDate, exitReason: 'manual' }
  if (sellQty === pos.qty) {
    await repo.markClosed(id, exit)
  } else {
    await repo.insertClosedLot(pos, sellQty, exit)
    await repo.setQty(id, pos.qty - sellQty)
  }
  await repo.adjustCash(user, sellQty * exitPrice)
  return { ok: true, exitPrice, exitDate, realizedPnl: sellQty * (exitPrice - pos.entryPrice) }
}

export async function updateStops(user: string, id: number, stopLoss: number | null, target: number | null): Promise<{ ok: boolean; error?: string }> {
  const pos = await repo.getPosition(id)
  if (!pos || pos.status !== 'open' || pos.userEmail !== user) return { ok: false, error: 'position not found or already closed' }
  if (stopLoss != null && (!Number.isFinite(stopLoss) || stopLoss <= 0)) return { ok: false, error: 'invalid stop-loss' }
  if (target != null && (!Number.isFinite(target) || target <= 0)) return { ok: false, error: 'invalid target' }
  if (stopLoss != null && target != null && stopLoss >= target) return { ok: false, error: 'stop-loss must be below target' }
  await repo.setStops(id, stopLoss, target)
  return { ok: true }
}

// ——— stop-loss / target sweep (runs after the daily ingest AND lazily on every portfolio read) ———

/** Replay open positions' daily bars since entry; trigger SL/target gap-aware.
 *  Sweeps ONE user's positions when `user` is given (lazy, on portfolio read) or
 *  EVERY user's (the daily scheduler sweep). Idempotent — a triggered position
 *  closes once and leaves the open set; cash returns to the position's owner. */
export async function evaluateStops(user?: string): Promise<number> {
  const open = await repo.openPositions(user)
  let closed = 0
  for (const pos of open) {
    if (pos.stopLoss == null && pos.target == null) continue
    const bars = await pricesRepo.barsAfter(pos.symbol, pos.entryDate).catch(() => [])
    for (const bar of bars) {
      const sl = pos.stopLoss
      const tgt = pos.target
      let exit: { price: number; reason: 'stop-loss' | 'target' } | null = null
      // Ambiguity (bar touches both) resolves to the stop — the conservative read.
      if (sl != null && bar.open <= sl) exit = { price: bar.open, reason: 'stop-loss' } // gapped below → open fill
      else if (sl != null && bar.low <= sl) exit = { price: sl, reason: 'stop-loss' }
      else if (tgt != null && bar.open >= tgt) exit = { price: bar.open, reason: 'target' } // gapped above
      else if (tgt != null && bar.high >= tgt) exit = { price: tgt, reason: 'target' }
      if (exit) {
        await repo.markClosed(pos.id, { exitPrice: exit.price, exitDate: bar.date, exitReason: exit.reason })
        await repo.adjustCash(pos.userEmail, pos.qty * exit.price)
        console.log(`[paper] ${pos.symbol} #${pos.id} ${exit.reason} hit ${bar.date} @ ₹${exit.price} (qty ${pos.qty})`)
        closed++
        break
      }
    }
  }
  return closed
}

/** Scheduler wrapper — no-ops unless the guidance desk is enabled; never throws. */
export async function paperStopSweep(): Promise<void> {
  if (process.env.GUIDANCE_ENABLED !== 'true') return
  try {
    const n = await evaluateStops()
    if (n > 0) console.log(`[paper] stop sweep closed ${n} position(s)`)
  } catch (e) {
    console.warn('[paper] stop sweep failed:', (e as Error).message)
  }
}

// ——— the portfolio view ———

export interface OpenPositionView {
  id: number
  symbol: string
  name: string | null
  qty: number
  entryPrice: number
  entryDate: string
  stopLoss: number | null
  target: number | null
  tierAtEntry: string | null
  scoreAtEntry: number | null
  notes: string | null
  ltp: number | null
  ltpDate: string | null
  ltpLive: boolean // marked to a live delayed quote (true) or the last EOD close (false)
  value: number | null
  pnl: number | null
  pnlPct: number | null
  dayChangePct: number | null
  vsNiftyPct: number | null // excess over NIFTY since entry — the honest scoreboard
}

export interface ClosedPositionView {
  id: number
  symbol: string
  name: string | null
  qty: number
  entryPrice: number
  entryDate: string
  exitPrice: number
  exitDate: string
  exitReason: string
  tierAtEntry: string | null
  pnl: number
  pnlPct: number
  alphaPct: number | null // trade return minus NIFTY's return over the same holding window
}

export interface Portfolio {
  account: {
    startingCapital: number
    cash: number
    invested: number
    currentValue: number // open positions marked to latest close
    portfolioValue: number // cash + currentValue
    unrealizedPnl: number
    realizedPnl: number
    dayPnl: number
    totalReturnPct: number // portfolioValue vs startingCapital
  }
  open: OpenPositionView[]
  closed: ClosedPositionView[]
  note: string
}

export async function portfolio(user: string): Promise<Portfolio> {
  await evaluateStops(user) // lazy sweep — SL/target honored even if the scheduler missed a day
  const [account, openRows, closedRows, names] = await Promise.all([
    repo.getAccount(user),
    repo.openPositions(user),
    repo.closedPositions(user),
    instrumentsRepo.listSymbolName().then((rows) => new Map(rows.map((r) => [r.symbol, r.name]))).catch(() => new Map<string, string>()),
  ])

  const quotes = await quotesFor(openRows.map((p) => p.symbol))

  const open: OpenPositionView[] = []
  for (const p of openRows) {
    const q = quotes.get(p.symbol) ?? null
    const value = q ? p.qty * q.price : null
    const pnl = q ? p.qty * (q.price - p.entryPrice) : null
    const pnlPct = q ? ((q.price - p.entryPrice) / p.entryPrice) * 100 : null
    const idx = q ? await indexReturnPct(p.entryDate, q.date).catch(() => null) : null
    open.push({
      id: p.id,
      symbol: p.symbol,
      name: names.get(p.symbol) ?? null,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryDate: p.entryDate,
      stopLoss: p.stopLoss,
      target: p.target,
      tierAtEntry: p.tierAtEntry,
      scoreAtEntry: p.scoreAtEntry,
      notes: p.notes,
      ltp: q?.price ?? null,
      ltpDate: q?.date ?? null,
      ltpLive: q?.live ?? false,
      value,
      pnl,
      pnlPct,
      dayChangePct: q?.prevClose != null ? ((q.price - q.prevClose) / q.prevClose) * 100 : null,
      vsNiftyPct: pnlPct != null && idx != null ? round2(pnlPct - idx) : null,
    })
  }

  const closed: ClosedPositionView[] = []
  for (const p of closedRows) {
    if (p.exitPrice == null || p.exitDate == null) continue
    const pnlPct = ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100
    // Alpha: what the trade made MINUS what parking the same money in the NIFTY over the
    // exact same holding window would have made. This is the desk's honest scoreboard.
    const idx = await indexReturnPct(p.entryDate, p.exitDate).catch(() => null)
    closed.push({
      id: p.id,
      symbol: p.symbol,
      name: names.get(p.symbol) ?? null,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryDate: p.entryDate,
      exitPrice: p.exitPrice,
      exitDate: p.exitDate,
      exitReason: p.exitReason ?? 'manual',
      tierAtEntry: p.tierAtEntry,
      pnl: p.qty * (p.exitPrice - p.entryPrice),
      pnlPct,
      alphaPct: idx != null ? round2(pnlPct - idx) : null,
    })
  }

  const invested = openRows.reduce((s, p) => s + p.qty * p.entryPrice, 0)
  const currentValue = open.reduce((s, p) => s + (p.value ?? p.qty * p.entryPrice), 0)
  const unrealizedPnl = open.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const realizedPnl = closed.reduce((s, p) => s + p.pnl, 0)
  const dayPnl = open.reduce((s, p) => {
    const q = quotes.get(p.symbol)
    return q?.prevClose != null ? s + p.qty * (q.price - q.prevClose) : s
  }, 0)
  const portfolioValue = account.cash + currentValue

  return {
    account: {
      startingCapital: account.startingCapital,
      cash: account.cash,
      invested,
      currentValue,
      portfolioValue,
      unrealizedPnl,
      realizedPnl,
      dayPnl,
      totalReturnPct: account.startingCapital > 0 ? ((portfolioValue - account.startingCapital) / account.startingCapital) * 100 : 0,
    },
    open,
    closed,
    note: 'Mock money on real prices — marked to ~15-min-delayed live quotes during market hours (EOD close otherwise), stop-loss/target replayed gap-aware on daily bars, no brokerage/taxes applied.',
  }
}

// ——— trade logs: per-position daily P&L since entry ———

const round2 = (n: number) => Math.round(n * 100) / 100

export interface PositionLogPoint {
  date: string
  close: number
  dayPnl: number // what this position made/lost THAT day (₹)
  cumPnl: number // total P&L vs entry as of that day (₹)
  live?: boolean // latest point marked to the delayed live quote
}

export interface PositionLog {
  id: number
  symbol: string
  name: string | null
  qty: number
  entryPrice: number
  entryDate: string
  todayPnl: number | null // ₹ made/lost today (vs yesterday's close)
  todayPct: number | null
  totalPnl: number | null
  series: PositionLogPoint[]
}

/** Day-by-day log for every open position: entry day measures vs the entry price,
 *  every later day vs the prior close, and the latest point is the live mark. */
export async function positionLogs(user: string): Promise<{ positions: PositionLog[]; note: string }> {
  const openRows = await repo.openPositions(user)
  const names = await instrumentsRepo.listSymbolName().then((rows) => new Map(rows.map((r) => [r.symbol, r.name]))).catch(() => new Map<string, string>())
  const quotes = await quotesFor(openRows.map((p) => p.symbol))

  const out: PositionLog[] = []
  for (const p of openRows) {
    const bars = (await pricesRepo.equityRows(p.symbol).catch(() => [])).filter((b) => b.date >= p.entryDate)
    const series: PositionLogPoint[] = []
    let prev = p.entryPrice
    for (const b of bars) {
      series.push({ date: b.date, close: b.close, dayPnl: round2(p.qty * (b.close - prev)), cumPnl: round2(p.qty * (b.close - p.entryPrice)) })
      prev = b.close
    }
    const q = quotes.get(p.symbol)
    const last = series[series.length - 1]
    if (q && (!last || q.date > last.date)) {
      series.push({ date: q.date, close: q.price, dayPnl: round2(p.qty * (q.price - prev)), cumPnl: round2(p.qty * (q.price - p.entryPrice)), live: q.live })
    } else if (q?.live && last && q.date === last.date) {
      // same session: replace the stored bar with the fresher live mark
      const before = series.length >= 2 ? series[series.length - 2].close : p.entryPrice
      series[series.length - 1] = { date: q.date, close: q.price, dayPnl: round2(p.qty * (q.price - before)), cumPnl: round2(p.qty * (q.price - p.entryPrice)), live: true }
    }
    // "Today" must measure what YOU made/lost today: positions bought today baseline
    // at the fill price (yesterday's close would charge you a move you never held).
    const todayBase = q ? (q.date === p.entryDate ? p.entryPrice : q.prevClose) : null
    out.push({
      id: p.id,
      symbol: p.symbol,
      name: names.get(p.symbol) ?? null,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryDate: p.entryDate,
      todayPnl: q && todayBase != null ? round2(p.qty * (q.price - todayBase)) : null,
      todayPct: q && todayBase != null && todayBase !== 0 ? round2(((q.price - todayBase) / todayBase) * 100) : null,
      totalPnl: series.length ? series[series.length - 1].cumPnl : null,
      series,
    })
  }
  out.sort((a, b) => (a.todayPnl ?? 0) - (b.todayPnl ?? 0)) // worst hit today first
  return {
    positions: out,
    note: 'Daily P&L from stored NSE closes since your entry; the latest point is the ~15-min-delayed live mark during market hours. Entry day measures against your fill price.',
  }
}

// ——— starred watchlist, enriched for the UI ———

export interface StarView {
  symbol: string
  name: string | null
  starredAt: string
  price: number | null
  priceDate: string | null
  move1d: number | null
}

export async function starsView(user: string): Promise<StarView[]> {
  const [stars, names] = await Promise.all([
    repo.listStars(user),
    instrumentsRepo.listSymbolName().then((rows) => new Map(rows.map((r) => [r.symbol, r.name]))).catch(() => new Map<string, string>()),
  ])
  const quotes = await quotesFor(stars.map((s) => s.symbol))
  const out: StarView[] = []
  for (const s of stars) {
    const q = quotes.get(s.symbol) ?? null
    out.push({
      symbol: s.symbol,
      name: names.get(s.symbol) ?? null,
      starredAt: s.starredAt,
      price: q?.price ?? null,
      priceDate: q?.date ?? null,
      move1d: q?.prevClose != null ? ((q.price - q.prevClose) / q.prevClose) * 100 : null,
    })
  }
  return out
}
