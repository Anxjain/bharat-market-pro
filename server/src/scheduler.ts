// Daily scheduler (node-cron) for THIS copy. Registers a month-rollover/staleness
// check across insurers plus an optional archive-first refresh. Idempotent (uses
// the same pipeline as the CLI). Runs only when this copy runs; disable with
// SCHEDULER_ENABLED=false. Live fetching is opt-in via SCHEDULER_FETCH=1 so the
// scheduler is safe to register in environments without network.
import cron from 'node-cron'
import { ADAPTERS } from './ulip/adapters'
import { runInsurerMonth } from './ulip/pipeline'
import { ingestIciciWeb } from './ulip/icici-web'
import { freshness } from './ulip/freshness'
import { ingestRecent } from './ingest/bhavcopy'
import { refreshInsurerKpis } from './ingest/insurer-kpis-fetch'
import { triggerScan } from './guidance/scan'
import { paperStopSweep } from './guidance/portfolio'
import { nightlyLabelUpdate } from './guidance/labels'
import { sellAdvisorSweep } from './guidance/sellAdvisor'
import { evaluateAlertRules } from './alert-rules'
import { sendDailyDigest } from './guidance/digest'
import { mailConfigured } from './mail'
import { tailRefresh } from './guidance/history'
import * as guidanceBoardRepo from './repositories/guidanceBoard'
import * as guidanceWatchlistRepo from './repositories/guidanceWatchlist'
import * as quotesHistoryRepo from './repositories/quotesHistory'
import * as newsRepo from './repositories/news'
import { prevMonth } from './util/shared'

/** Pull the latest NSE EOD prices (open/close for every company). Logs, never throws. */
export async function dailyPriceIngest(): Promise<void> {
  try {
    console.log('[scheduler] daily NSE price ingest starting…')
    const { sessions } = await ingestRecent(5) // last few sessions to fill any gaps
    console.log(`[scheduler] daily price ingest done — ${sessions} session(s) refreshed`)
  } catch (e) {
    console.warn('[scheduler] price ingest failed:', (e as Error).message)
  }
}

/**
 * Keep the free-tier Supabase auth project warm. Supabase pauses a free project after
 * ~7 idle days, which makes login "won't load" (its subdomain stops resolving). Our
 * server never queries Supabase directly (auth is JWKS-only), so login traffic is the
 * only thing keeping it alive — a quiet week pauses it. A cheap daily request to the
 * project's public JWKS endpoint (served DYNAMIC by Cloudflare → hits the origin, so it
 * counts as activity) resets the idle timer. No secret needed: SUPABASE_URL is enough.
 * Logs, never throws.
 */
export async function supabaseKeepAlive(): Promise<void> {
  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  if (!base) return
  try {
    const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`, {
      headers: { 'User-Agent': 'bharat-market-pro-keepalive' },
      signal: AbortSignal.timeout(15_000),
    })
    console.log(`[scheduler] supabase keep-alive ping → ${res.status}`)
  } catch (e) {
    console.warn('[scheduler] supabase keep-alive failed:', (e as Error).message)
  }
}

export function currentMonth(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Compare each active insurer's latest stored month to the current month. */
export async function monthRolloverCheck(): Promise<{ current: string; behind: string[] }> {
  const current = currentMonth()
  const rows = await freshness()
  const behind: string[] = []
  for (const r of rows) {
    if (r.status !== 'active') continue
    if (r.latestStored !== current) {
      const msg = `${r.name} (${r.code}): latest ${r.latestStored ?? 'none'} < ${current}`
      behind.push(msg)
      console.warn(`[scheduler] STALE INTO NEW MONTH — ${msg}`)
    }
  }
  if (behind.length === 0) console.log(`[scheduler] all active insurers current for ${current}`)
  return { current, behind }
}

export async function dailyJob(): Promise<void> {
  const { current, behind } = await monthRolloverCheck()
  if (process.env.SCHEDULER_FETCH === '1' && behind.length > 0) {
    console.log(`[scheduler] SCHEDULER_FETCH=1 — attempting archive-first refresh for ${current}`)
    for (const id of Object.keys(ADAPTERS)) {
      try { await runInsurerMonth(id, current) } catch (e) { console.warn(`[scheduler] ${id} refresh failed: ${(e as Error).message}`) }
    }
  }
}

/**
 * Monthly ULIP pull: fetch the PRIOR month's factsheets (insurers publish month N's
 * sheet in early month N+1, so we run on the 3rd). Idempotent — a month already
 * stored is skipped. Direct-URL insurers (HDFC/Kotak/PNB/Bharti/Tata) fetch live;
 * the bot-protected ones (ICICI/Bandhan/SBI) gap unless a PDF is dropped in intake/.
 */
export async function monthlyUlipFetch(month = prevMonth()): Promise<void> {
  console.log(`[scheduler] monthly ULIP fetch for ${month} starting…`)
  let stored = 0
  for (const id of Object.keys(ADAPTERS)) {
    // ICICI has NO portfolio PDF — its holdings come from the web API (icici-web.ts).
    // Running the PDF pipeline for it would store returns-only data (no holdings), so
    // it's handled separately below.
    if (id === 'icicipru') continue
    try {
      const s = await runInsurerMonth(id, month)
      stored += s.stored
      console.log(`[scheduler] ${id} ${month}: stored ${s.stored}${s.alreadyHad ? ' (already had)' : ''}`)
    } catch (e) {
      console.warn(`[scheduler] ${id} ${month} fetch failed: ${(e as Error).message}`)
    }
  }
  // ICICI via web API (holdings + sector + asset from buy.iciciprulife.com).
  try {
    const r = await ingestIciciWeb()
    stored += r.stored
    console.log(`[scheduler] icicipru ${r.month}: stored ${r.stored} (${r.withHoldings} with holdings) via web API`)
  } catch (e) {
    console.warn(`[scheduler] icicipru web fetch failed: ${(e as Error).message}`)
  }
  console.log(`[scheduler] monthly ULIP fetch done — ${stored} funds stored for ${month}`)
}

/**
 * CR-7: keep the guidance deep price-history TAIL fresh. `ensureHistory` used to stop
 * refetching once a symbol had ≥250 rows, so backfilled names silently computed their
 * whole timing axis (drop, RSI, base-rate direction) on frozen data. After the evening
 * bhavcopy ingest, incrementally top up the watchlist's deep series (the 19:00 scan now
 * keeps board names fresh via the same stale-tail refetch). Guidance-gated; never throws.
 */
export async function guidanceTailRefresh(): Promise<void> {
  if (process.env.GUIDANCE_ENABLED !== 'true') return
  try {
    const symbols = (await guidanceWatchlistRepo.list()).map((w) => w.symbol)
    if (symbols.length === 0) return
    const { refreshed, skipped } = await tailRefresh(symbols)
    console.log(`[scheduler] guidance tail-refresh — ${refreshed} updated, ${skipped} already fresh (${symbols.length} watchlist)`)
  } catch (e) {
    console.warn('[scheduler] guidance tail-refresh failed:', (e as Error).message)
  }
}

/** M-B4: daily retention prune of the append-only capture tables so they don't grow
 *  unbounded — quote history >90d and durable news >180d. Logs, never throws. */
export async function dailyPrune(): Promise<void> {
  try {
    const quotes = await quotesHistoryRepo.pruneOlderThan(90)
    const news = await newsRepo.pruneOlderThan(180)
    console.log(`[scheduler] daily prune — removed ${quotes} quote-history rows (>90d), ${news} news rows (>180d)`)
  } catch (e) {
    console.warn('[scheduler] daily prune failed:', (e as Error).message)
  }
}

/**
 * M-B17: boot catch-up for the monthly ULIP fetch. The monthly cron only fires on the
 * 3rd — if the process was down that day (or was never running), a month silently
 * gaps. On boot, if the 3rd has passed and any active insurer's latest stored month is
 * behind the prior calendar month, run the fetch once.
 */
async function ulipBootCatchUp(): Promise<void> {
  try {
    if (new Date().getUTCDate() < 3) return // publishers haven't posted the prior month yet
    const prev = prevMonth()
    const rows = await freshness()
    const behind = rows.some((r) => r.status === 'active' && (!r.latestStored || r.latestStored < prev))
    if (!behind) return
    console.log(`[scheduler] boot catch-up: ULIP behind ${prev} — running monthly fetch once`)
    await monthlyUlipFetch(prev)
  } catch (e) {
    console.warn('[scheduler] ULIP boot catch-up failed:', (e as Error).message)
  }
}

export function startScheduler(): void {
  if (process.env.SCHEDULER_ENABLED === 'false') { console.log('[scheduler] disabled (SCHEDULER_ENABLED=false)'); return }
  const tz = process.env.SCHEDULER_TZ ?? 'Asia/Kolkata'
  // Daily 06:30 IST: month-rollover / staleness check (+ optional ULIP refresh).
  cron.schedule('30 6 * * *', () => { dailyJob().catch((e) => console.warn('[scheduler] daily job error:', (e as Error).message)) }, { timezone: tz })

  // Daily NSE EOD price ingest (open/close for every company). NSE publishes the
  // bhavcopy after market close, so run on weekday evenings. On by default; disable
  // with SCHEDULER_INGEST=0. Also runs once shortly after boot to fill any gap.
  if (process.env.SCHEDULER_INGEST !== '0') {
    // After the fresh bhavcopy lands: top up guidance deep history, run the paper-trading
    // stop sweep on the new bars, mature the outcome labels (the measurement loop), then
    // the sell advisor reviews every user's holdings against the fresh data.
    // AUDIT FIX (2026-07-14): the 18:30 cron and the boot catch-up (30s after start) could
    // both run this chain at once — overlapping ingest + label writes + stop sweeps. An
    // in-flight guard makes concurrent invocations no-op instead of racing.
    let eveningRunning = false
    const evening = async () => {
      if (eveningRunning) { console.log('[scheduler] evening chain already running — skipping overlap'); return }
      eveningRunning = true
      try {
        await dailyPriceIngest()
        await guidanceTailRefresh()
        await paperStopSweep()
        await nightlyLabelUpdate()
        await sellAdvisorSweep()
      } finally {
        eveningRunning = false
      }
    }
    cron.schedule('30 18 * * 1-5', () => { evening() }, { timezone: tz })
    setTimeout(() => { evening() }, 30_000) // catch-up ~30s after startup
    console.log(`[scheduler] registered daily NSE price ingest (18:30 ${tz}, Mon–Fri) + boot catch-up`)
  } else {
    console.log('[scheduler] daily price ingest disabled (SCHEDULER_INGEST=0)')
  }
  // Rule-based custom alerts (9.7) — evaluate the user's rule set against the fresh
  // evening bhavcopy (18:30 ingest above) and mail the new hits. Runs at 18:50 so the
  // ingest has settled. On by default; disable with SCHEDULER_ALERT_RULES=0.
  if (process.env.SCHEDULER_ALERT_RULES !== '0') {
    cron.schedule('50 18 * * 1-5', () => { evaluateAlertRules().catch((e) => console.warn('[scheduler] alert-rules error:', (e as Error).message)) }, { timezone: tz })
    console.log(`[scheduler] registered alert-rules evaluation (18:50 ${tz}, Mon–Fri) — SMTP ${mailConfigured() ? 'configured' : 'NOT configured (hits stored, mail skipped)'}`)
  }

  // Monthly ULIP fetch — on the 3rd at 07:00 IST, pull the prior month's just-published
  // factsheets for every insurer. On by default; disable with SCHEDULER_ULIP_FETCH=0.
  if (process.env.SCHEDULER_ULIP_FETCH !== '0') {
    cron.schedule('0 7 3 * *', () => { monthlyUlipFetch().catch((e) => console.warn('[scheduler] monthly ULIP fetch error:', (e as Error).message)) }, { timezone: tz })
    setTimeout(() => { ulipBootCatchUp() }, 120_000) // boot catch-up ~2min after startup (M-B17)
    console.log(`[scheduler] registered monthly ULIP fetch (3rd @ 07:00 ${tz} → fetches prior month) + boot catch-up`)
  }
  console.log(`[scheduler] registered daily ULIP month-rollover check (06:30 ${tz}); live refresh ${process.env.SCHEDULER_FETCH === '1' ? 'ON' : 'OFF'}`)

  // Daily retention prune (03:00 IST) of the append-only capture tables (M-B4). On by
  // default; disable with SCHEDULER_PRUNE=0.
  if (process.env.SCHEDULER_PRUNE !== '0') {
    cron.schedule('0 3 * * *', () => { dailyPrune() }, { timezone: tz })
    console.log(`[scheduler] registered daily retention prune (03:00 ${tz})`)
  }

  // Insurer-KPI refresh — insurers report quarterly (~45 days after quarter-end). Check
  // monthly on the 5th at 08:00 IST; the parser only overwrites a curated value when it
  // reads a fresh, in-range figure, so running often is safe. Disable with
  // SCHEDULER_INSURER_KPIS=0. Needs a configured pdfUrl or an intake/ PDF per insurer.
  if (process.env.SCHEDULER_INSURER_KPIS !== '0') {
    cron.schedule('0 8 5 * *', () => { refreshInsurerKpis().catch((e) => console.warn('[scheduler] insurer-kpis error:', (e as Error).message)) }, { timezone: tz })
    console.log(`[scheduler] registered monthly insurer-KPI refresh (5th @ 08:00 ${tz})`)
  }

  // Supabase keep-alive — free-tier projects auto-pause after ~7 idle days, breaking
  // login. A cheap daily ping keeps it warm (huge margin vs the 7-day window). On by
  // default; disable with SCHEDULER_SUPABASE_PING=0. No-ops when SUPABASE_URL isn't set.
  if (process.env.SCHEDULER_SUPABASE_PING !== '0') {
    cron.schedule('0 5 * * *', () => { supabaseKeepAlive() }, { timezone: tz })
    setTimeout(() => { supabaseKeepAlive() }, 90_000) // one ping shortly after boot
    console.log(`[scheduler] registered Supabase keep-alive ping (05:00 ${tz} daily) + boot ping`)
  }

  // Guidance opportunity scan (PRIVATE desk) — only when the desk is enabled. Runs after
  // the evening price ingest on weekdays, and once shortly after boot if no board exists.
  if (process.env.GUIDANCE_ENABLED === 'true' && process.env.GUIDANCE_SCAN !== '0') {
    cron.schedule('0 19 * * 1-5', () => { triggerScan() }, { timezone: tz })
    setTimeout(async () => {
      try { if (!(await guidanceBoardRepo.latest())) triggerScan() } catch { /* ignore */ }
    }, 60_000)
    console.log(`[scheduler] registered guidance opportunity scan (19:00 ${tz}, Mon–Fri) + boot catch-up`)

    // Daily digest email (9.3) — deliver the scan the desk already computed. Runs at
    // 19:30 IST, decoupled from the scan itself (a scan takes a few minutes; the digest
    // reads the persisted board and skips if it isn't from today, so a failed scan can
    // never re-mail stale calls). Requires SMTP_* env; disable with SCHEDULER_DIGEST=0.
    if (process.env.SCHEDULER_DIGEST !== '0') {
      cron.schedule('30 19 * * 1-5', () => { sendDailyDigest().catch((e) => console.warn('[scheduler] digest error:', (e as Error).message)) }, { timezone: tz })
      console.log(`[scheduler] registered guidance daily digest (19:30 ${tz}, Mon–Fri) — SMTP ${mailConfigured() ? 'configured' : 'NOT configured (will skip)'}`)
    }
  }
}
