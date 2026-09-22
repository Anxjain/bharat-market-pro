// Investment Guidance API (PRIVATE) — Hono sub-app mounted at /api/guidance.
//
// HARD ISOLATION: every route is gated. If GUIDANCE_ENABLED is not true, or the caller
// is not a verified owner, the route 404s (NOT 403) so the section is never advertised.
// The public app is entirely unaffected when the flag is off.
//
// Local-dev escape hatch: GUIDANCE_DEV_OPEN=true skips the owner check (still requires
// GUIDANCE_ENABLED). DEV/LOCALHOST ONLY — never set it on a deployed instance.
import { Hono } from 'hono'
import { userFromAuthHeader, bearerExpired } from '../auth'
import { computeSignal, scanWatchlist } from './signal'
import { analystBrief } from './analyst'
import { ensureHistory } from './history'
import { triggerScan, isScanning, weeklyBoard, type Board } from './scan'
import { computeTrackRecord } from './trackRecord'
import { computeStreaks } from './streaks'
import { portfolio, placeOrder, closePosition, updateStops, starsView, positionLogs } from './portfolio'
import * as ptRepo from '../repositories/paperTrading'
import * as usersRepo from '../repositories/guidanceUsers'
import * as labelsRepo from '../repositories/guidanceLabels'
import { computeMomentumBoard } from './momentum'
import * as notifRepo from '../repositories/guidanceNotifications'
import { buildDigest, sendDailyDigest, digestRecipients } from './digest'
import { mailConfigured } from '../mail'
import { computeSetupCalibration } from './backtest'
import * as histRepo from '../repositories/guidancePriceHistory'
import * as pricesRepo from '../repositories/prices'
import { computeRegime } from './regime'
import * as watchRepo from '../repositories/guidanceWatchlist'
import * as cfgRepo from '../repositories/guidanceConfig'
import * as boardRepo from '../repositories/guidanceBoard'

export function guidanceEnabled(): boolean {
  return process.env.GUIDANCE_ENABLED === 'true'
}

function owners(): string[] {
  return (process.env.GUIDANCE_OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Resolve the caller to an access grant (null = no access). Two tiers:
 *  ADMIN — email in GUIDANCE_OWNER_EMAILS (env, permanent; can manage members);
 *  MEMBER — email in guidance_users (granted from the in-app admin panel).
 *  The email is also the per-user key for the paper-trading data. */
async function resolveAccess(authHeader: string | undefined | null): Promise<{ email: string; admin: boolean } | null> {
  // DEV ONLY escape hatch — hard-guarded so it can NEVER open the desk on a production build,
  // even if the env var is left set by mistake. (L)
  if (process.env.GUIDANCE_DEV_OPEN === 'true' && process.env.NODE_ENV !== 'production') return { email: 'dev@local', admin: true }
  const user = await userFromAuthHeader(authHeader)
  if (!user?.email) return null
  const email = user.email.toLowerCase()
  // Ledger every verified login — INCLUDING ones we then deny. Every signed-in visitor's
  // browser probes /status, so this is what makes new signups appear in the admin panel
  // as "awaiting approval". Fire-and-forget; never blocks or fails the request.
  usersRepo.touchSeen(email).catch(() => {})
  if (owners().includes(email)) return { email, admin: true }
  if (await usersRepo.has(email)) return { email, admin: false }
  return null
}

export const guidanceApi = new Hono<{ Variables: { ownerEmail: string; isAdmin: boolean } }>()

// Gate: disabled OR no grant → 404 (don't reveal the section exists). The verified
// email + admin flag ride on the context for the routes below.
//
// One deliberate exception to the blanket 404: a caller presenting an EXPIRED token gets
// 401. Access tokens lapse after ~1h, and a 404 there is indistinguishable from "no
// access", so the browser used to keep replaying the dead token and render an empty page
// until a manual reload. 401 tells the client to renew and retry. It reveals nothing —
// the caller already held a valid session, and an expired token grants nothing.
guidanceApi.use('*', async (c, next) => {
  if (!guidanceEnabled()) return c.json({ error: 'not found' }, 404)
  const authHeader = c.req.header('Authorization')
  const access = await resolveAccess(authHeader)
  if (!access) {
    if (bearerExpired(authHeader)) return c.json({ error: 'session expired' }, 401)
    return c.json({ error: 'not found' }, 404)
  }
  c.set('ownerEmail', access.email)
  c.set('isAdmin', access.admin)
  await next()
})

// Reachable only with a grant → a 200 here is the frontend's signal to show the nav
// entry; `admin` additionally unlocks the Manage-access panel.
guidanceApi.get('/status', (c) => c.json({ enabled: true, owner: true, admin: c.get('isAdmin') }))

// ——— access management (ADMIN only — the env-listed owners) ———
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

guidanceApi.get('/users', async (c) => {
  if (!c.get('isAdmin')) return c.json({ error: 'not found' }, 404)
  const [users, seen] = await Promise.all([usersRepo.list(), usersRepo.listSeen()])
  // Pending = signed in to the site at some point, but not yet an admin or member.
  const granted = new Set([...owners(), ...users.map((u) => u.userEmail)])
  const pending = seen.filter((s) => !granted.has(s.userEmail))
  return c.json({ admins: owners(), users, pending })
})

guidanceApi.post('/users', async (c) => {
  if (!c.get('isAdmin')) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => null)) as { email?: string } | null
  const email = b?.email?.trim().toLowerCase() ?? ''
  if (!EMAIL_RX.test(email)) return c.json({ error: 'invalid email' }, 400)
  if (owners().includes(email)) return c.json({ error: 'already an admin (managed via the VM env)' }, 400)
  await usersRepo.add(email, c.get('ownerEmail'))
  return c.json({ ok: true })
})

guidanceApi.delete('/users/:email', async (c) => {
  if (!c.get('isAdmin')) return c.json({ error: 'not found' }, 404)
  await usersRepo.remove(decodeURIComponent(c.req.param('email')).toLowerCase())
  return c.json({ ok: true })
})

// ——— track record: realized forward outcomes of the desk's own past calls ———
guidanceApi.get('/track-record', async (c) => c.json(await computeTrackRecord()))

// ——— setup calibration: universe-wide empirical odds after each move band (backtest) ———
guidanceApi.get('/calibration', async (c) => c.json(await computeSetupCalibration(c.req.query('force') === '1')))

// ——— 5-day winning streaks: closed higher EVERY session, from the daily price record ———
guidanceApi.get('/streaks', async (c) => c.json(await computeStreaks()))

// ——— momentum board: 6m/3m relative strength (skip-month) + earnings confirmation ———
guidanceApi.get('/momentum', async (c) => c.json(await computeMomentumBoard()))

// ——— grading: every snapshotted tier call scored against measured forward outcomes ———
guidanceApi.get('/grading', async (c) => {
  const [tiers, labels] = await Promise.all([labelsRepo.gradeTiers(), labelsRepo.count()])
  return c.json({
    tiers,
    labelRows: labels,
    note: 'Each distinct (name, day, tier) call the desk snapshotted, joined to what ACTUALLY happened next. x-columns are excess vs NIFTY over the same window — beating the index, not just a bull market. Grades sharpen as calls mature (r60 needs 60 sessions).',
  })
})

// ——— sell-advisor notifications (per-user) ———
guidanceApi.get('/notifications', async (c) => {
  const user = c.get('ownerEmail')
  const [items, unread] = await Promise.all([notifRepo.listFor(user), notifRepo.unreadCount(user)])
  return c.json({ items, unread })
})

guidanceApi.post('/notifications/read', async (c) => {
  const user = c.get('ownerEmail')
  const b = (await c.req.json().catch(() => ({}))) as { id?: number }
  if (b.id != null) await notifRepo.markRead(user, Number(b.id))
  else await notifRepo.markAllRead(user)
  return c.json({ ok: true })
})

// ——— current market regime (NIFTY trend + vol + drawdown → caution) ———
guidanceApi.get('/regime', async (c) => c.json(computeRegime(await histRepo.closesAsc('^NSEI'))))

// ——— price history for the signal chart (multi-year deep history, else recent store) ———
guidanceApi.get('/history/:symbol', async (c) => {
  const sym = c.req.param('symbol').toUpperCase()
  const deep = await histRepo.candlesAsc(sym)
  let candles = deep.map((k) => ({ date: k.date, o: k.open ?? k.close, h: k.high ?? k.close, l: k.low ?? k.close, c: k.close, v: k.volume ?? 0 }))
  if (candles.length === 0) {
    // fall back to the recent NSE price store if the deep history isn't populated yet
    const recent = await pricesRepo.equityRows(sym).catch(() => [])
    candles = recent.map((r) => ({ date: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume }))
  }
  return c.json({ candles })
})

// ——— opportunity board (the always-on scanner) ———
guidanceApi.get('/opportunities', async (c) => {
  const latest = await boardRepo.latest<Board>().catch(() => null)
  return c.json({ board: latest?.json ?? null, scanning: isScanning() })
})

// "This week" aggregate of the persisted scan boards (deduped, best-per-name + ×n count).
guidanceApi.get('/opportunities/week', async (c) => {
  const board = await weeklyBoard().catch(() => null)
  return c.json({ board, scanning: isScanning() })
})

guidanceApi.post('/scan', async (c) => {
  const deepN = Number(c.req.query('deepN') ?? 0) || undefined
  const started = triggerScan({ deepN })
  return c.json({ started, scanning: true })
})

// ——— daily digest (9.3) — preview the email in the browser, or send it now ———
guidanceApi.get('/digest', async (c) => {
  const digest = await buildDigest()
  if (!digest) return c.json({ error: 'no scan board yet — run a scan first' }, 404)
  return c.html(digest.html)
})

guidanceApi.post('/digest/send', async (c) => {
  const sent = await sendDailyDigest({ force: c.req.query('force') === '1' })
  return c.json({ sent, mailConfigured: mailConfigured(), recipients: digestRecipients() })
})

// ——— watchlist ———
guidanceApi.get('/watchlist', async (c) => c.json({ flags: await scanWatchlist() }))

guidanceApi.post('/watchlist', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { symbol?: string; thesis?: string; tags?: string[] } | null
  if (!b?.symbol) return c.json({ error: 'symbol required' }, 400)
  await watchRepo.add(b.symbol, b.thesis ?? null, Array.isArray(b.tags) ? b.tags : [])
  return c.json({ ok: true })
})

guidanceApi.patch('/watchlist/:symbol', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { active?: boolean } | null
  await watchRepo.setActive(c.req.param('symbol'), Boolean(b?.active))
  return c.json({ ok: true })
})

guidanceApi.delete('/watchlist/:symbol', async (c) => {
  await watchRepo.remove(c.req.param('symbol'))
  return c.json({ ok: true })
})

// ——— signal (factors + base rate) ———
guidanceApi.get('/signal/:symbol', async (c) => {
  const sig = await computeSignal(c.req.param('symbol'), { fetchIfMissing: true })
  return c.json(sig)
})

// ——— analyst brief (LLM, slower; separate so the page renders the rest first) ———
guidanceApi.get('/analyst/:symbol', async (c) => {
  const sig = await computeSignal(c.req.param('symbol'), { fetchIfMissing: true })
  const brief = await analystBrief(sig)
  if (!brief) return c.json({ error: 'analyst unavailable' }, 503)
  return c.json(brief)
})

// ——— tunable config ———
guidanceApi.get('/config', async (c) => c.json(await cfgRepo.getAll()))

// (L) Schema-validate PUT /config: only the three known keys, weights clamped to ≥0, and
// thresholds/tiers must have non-empty bands/horizons/tiers — a bad write (e.g. empty
// horizons) would otherwise self-DoS every signal computation.
const CONFIG_KEYS = new Set(['weights', 'thresholds', 'tiers'])
function validateConfig(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (key === 'weights') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'weights must be an object of { code: number }' }
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, error: `weight for "${k}" is not a number` }
      out[k] = Math.max(0, n) // clamp negatives to 0 — a negative weight would invert a factor
    }
    return { ok: true, value: out }
  }
  if (key === 'thresholds') {
    const t = value as Record<string, unknown> | null
    if (!t || typeof t !== 'object') return { ok: false, error: 'thresholds must be an object' }
    if ('dropBands' in t && (!Array.isArray(t.dropBands) || t.dropBands.length === 0)) return { ok: false, error: 'dropBands must be a non-empty array' }
    if ('horizons' in t && (!Array.isArray(t.horizons) || t.horizons.length === 0 || !t.horizons.every((h) => Number.isFinite(Number(h)) && Number(h) > 0)))
      return { ok: false, error: 'horizons must be a non-empty array of positive numbers' }
    return { ok: true, value }
  }
  if (key === 'tiers') {
    if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'tiers must be a non-empty array' }
    return { ok: true, value }
  }
  return { ok: false, error: 'unknown config key' }
}

guidanceApi.put('/config', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { key?: string; value?: unknown } | null
  if (!b?.key) return c.json({ error: 'key required' }, 400)
  if (!CONFIG_KEYS.has(b.key)) return c.json({ error: `unknown config key "${b.key}" (allowed: weights, thresholds, tiers)` }, 400)
  const v = validateConfig(b.key, b.value)
  if (!v.ok) return c.json({ error: v.error }, 400)
  await cfgRepo.set(b.key, v.value)
  return c.json({ ok: true })
})

// ——— on-demand deep-history backfill for one symbol ———
guidanceApi.post('/backfill/:symbol', async (c) => {
  const n = await ensureHistory(c.req.param('symbol'), { force: c.req.query('force') === '1' })
  return c.json({ symbol: c.req.param('symbol').toUpperCase(), rows: n })
})

// ——————————————————————————————————————————————————————————————
// Paper trading (mock money) — the private investment watchlist + broker-style
// mock portfolio. Same owner gate as everything above.
// ——————————————————————————————————————————————————————————————

// Starred symbols (the caller's private list), enriched with latest price + 1d move.
guidanceApi.get('/stars', async (c) => c.json({ stars: await starsView(c.get('ownerEmail')) }))

guidanceApi.post('/stars/:symbol', async (c) => {
  await ptRepo.addStar(c.get('ownerEmail'), c.req.param('symbol').toUpperCase())
  return c.json({ ok: true })
})

guidanceApi.delete('/stars/:symbol', async (c) => {
  await ptRepo.removeStar(c.get('ownerEmail'), c.req.param('symbol').toUpperCase())
  return c.json({ ok: true })
})

// The caller's mock portfolio (runs their SL/target sweep lazily before reporting).
guidanceApi.get('/portfolio', async (c) => c.json(await portfolio(c.get('ownerEmail'))))

// Trade logs: per-position day-by-day P&L since entry (today's damage first).
guidanceApi.get('/portfolio/logs', async (c) => c.json(await positionLogs(c.get('ownerEmail'))))

// Buy: fills at the live market price unless an explicit price is passed.
guidanceApi.post('/orders', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { symbol?: string; qty?: number; price?: number; stopLoss?: number; target?: number; notes?: string } | null
  if (!b?.symbol || b.qty == null) return c.json({ error: 'symbol and qty required' }, 400)
  const r = await placeOrder(c.get('ownerEmail'), { symbol: b.symbol, qty: b.qty, price: b.price, stopLoss: b.stopLoss, target: b.target, notes: b.notes })
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})

// Modify stop-loss / target on one of the caller's open positions (null clears it).
guidanceApi.patch('/positions/:id', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { stopLoss?: number | null; target?: number | null } | null
  if (!b) return c.json({ error: 'body required' }, 400)
  const r = await updateStops(c.get('ownerEmail'), Number(c.req.param('id')), b.stopLoss ?? null, b.target ?? null)
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400)
})

// Sell (full or partial qty) at the live market price, or an explicit price.
guidanceApi.post('/positions/:id/close', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { qty?: number; price?: number }
  const r = await closePosition(c.get('ownerEmail'), Number(c.req.param('id')), { qty: b.qty, price: b.price })
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})

// Reset the caller's mock account (wipes THEIR positions, restores capital).
guidanceApi.post('/portfolio/reset', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { capital?: number }
  const capital = Number(b.capital ?? ptRepo.DEFAULT_CAPITAL)
  if (!Number.isFinite(capital) || capital <= 0) return c.json({ error: 'invalid capital' }, 400)
  await ptRepo.resetAccount(c.get('ownerEmail'), capital)
  return c.json({ ok: true, capital })
})
