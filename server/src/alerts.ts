// Price alerts - user-created, server-evaluated against live quotes.
// Active alerts are checked every warm cycle (5 min) and on each list call;
// when a condition fires the alert moves to history with the trigger price.
// All SQL lives in the alerts repository.

import { getQuotes } from './quotes'
import * as alertsRepo from './repositories/alerts'
import { instrumentExists } from './repositories/instruments'

export interface Alert {
  id: number
  symbol: string
  condition: 'above' | 'below'
  price: number
  active: boolean
  createdAt: string
  triggeredAt: string | null
  triggerPrice: number | null
}

function rowToAlert(r: alertsRepo.AlertRow): Alert {
  return {
    id: r.id,
    symbol: r.symbol,
    condition: r.condition as 'above' | 'below',
    price: r.price,
    active: r.active,
    createdAt: r.createdAt,
    triggeredAt: r.triggeredAt ?? null,
    triggerPrice: r.triggerPrice ?? null,
  }
}

export async function listAlerts(symbol?: string): Promise<{ active: Alert[]; history: Alert[] }> {
  const rows = await alertsRepo.listRows(symbol ? symbol.toUpperCase() : undefined)
  const all = rows.map(rowToAlert)
  return {
    active: all.filter((a) => a.triggeredAt === null),
    history: all.filter((a) => a.triggeredAt !== null).slice(0, 30),
  }
}

export async function createAlert(symbol: string, condition: 'above' | 'below', price: number): Promise<Alert> {
  const sym = symbol.toUpperCase()
  if (!(await instrumentExists(sym))) throw new Error(`${sym} is not in the universe`)
  const row = await alertsRepo.insert(sym, condition, price, new Date().toISOString())
  return rowToAlert(row)
}

export async function setAlertActive(id: number, active: boolean): Promise<void> {
  await alertsRepo.setActive(id, active)
}

export async function deleteAlert(id: number): Promise<void> {
  await alertsRepo.remove(id)
}

// M-B6: single-flight guard. The GET /api/alerts path AND the 5-min warm cycle both
// trigger evaluation; two concurrent evaluators reading the same active rows could
// double-fire an alert. If an eval is already running, later callers no-op.
let evaluating = false

/** Check enabled, untriggered alerts against live quotes. Returns fired count. */
export async function evaluateAlerts(): Promise<number> {
  if (evaluating) return 0
  evaluating = true
  try {
    const rows = await alertsRepo.activeUntriggered()
    if (rows.length === 0) return 0
    const alerts = rows.map(rowToAlert)
    const quotes = await getQuotes([...new Set(alerts.map((a) => a.symbol))])
    const bySym = new Map(quotes.map((q) => [q.key, q]))

    let fired = 0
    for (const a of alerts) {
      const q = bySym.get(a.symbol)
      if (!q) continue
      const hit = a.condition === 'above' ? q.price >= a.price : q.price <= a.price
      if (hit) {
        await alertsRepo.fire(a.id, q.price, new Date().toISOString())
        fired++
        console.log(`[alerts] fired #${a.id} ${a.symbol} ${a.condition} ${a.price} @ ${q.price}`)
      }
    }
    return fired
  } finally {
    evaluating = false
  }
}
