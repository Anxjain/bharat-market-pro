// Rule-based custom alerts engine (9.7) — alerts beyond simple price thresholds.
//
// The existing alerts.ts answers "did SBIN cross ₹800?" against live quotes. This
// module answers screen-shaped questions like "any NIFTY500 name down ≥6% on ≥2×
// average volume with no news" or "any watchlist name with a new high-materiality
// filing". A rule is a small validated JSON of conditions (AND-ed together),
// evaluated after the evening bhavcopy ingest: per-symbol facts are computed ONCE
// from the last ~45 sessions of the price store (same data shaping as the guidance
// prescreen), matched against every enabled rule, persisted idempotently
// (rule+symbol+date unique) and mailed as one combined summary of NEW hits.
// All SQL lives in repositories; this module never throws (scheduler-safe).
import { z } from 'zod'
import * as pricesRepo from './repositories/prices'
import * as rulesRepo from './repositories/alertRules'
import * as newsRepo from './repositories/news'
import * as filingsRepo from './repositories/filings'
import * as watchlistsRepo from './repositories/watchlists'
import * as guidanceWatchlistRepo from './repositories/guidanceWatchlist'
import { sendMail, mailConfigured } from './mail'
import { digestRecipients, istDay } from './guidance/digest'

// ——— Rule condition schema (all present conditions AND together) ———
export const ruleConditionsSchema = z
  .object({
    universe: z.enum(['all', 'watchlist']),
    move1dPct: z.object({ op: z.enum(['<=', '>=']), value: z.number() }).optional(),
    volSpikeX: z.number().positive().optional(), // today's volume ≥ X × trailing 20-session avg
    minLiqCrore: z.number().positive().optional(), // avg daily traded value floor (₹ crore)
    noNews: z.boolean().optional(), // no stored news for the symbol in the last 2 days
    hasFiling: z
      .object({
        materiality: z.enum(['high', 'medium']).optional(), // minimum level; omit = any
        withinDays: z.number().int().positive().max(30),
      })
      .optional(),
  })
  .strict()
  // A universe with zero conditions would "hit" every symbol every session — reject it.
  .refine((c) => c.move1dPct || c.volSpikeX != null || c.minLiqCrore != null || c.noNews || c.hasFiling, {
    message: 'at least one condition (move1dPct/volSpikeX/minLiqCrore/noNews/hasFiling) is required',
  })

export type RuleConditions = z.infer<typeof ruleConditionsSchema>

export interface AlertRule {
  id: number
  name: string
  enabled: boolean
  conditions: RuleConditions
  createdAt: string
}

export interface RuleHit {
  id: number
  ruleId: number
  ruleName: string | null
  symbol: string
  date: string
  detail: Record<string, unknown>
  notified: boolean
  createdAt: string
}

// ——— CRUD (thin wrappers so routes stay SQL-free and shape-stable) ———

function rowToRule(r: rulesRepo.RuleRow): AlertRule {
  // Conditions were zod-validated on write; a bad legacy row degrades to a rule
  // that matches nothing rather than crashing the list.
  const parsed = ruleConditionsSchema.safeParse(r.conditions)
  return { id: r.id, name: r.name, enabled: r.enabled, conditions: parsed.success ? parsed.data : { universe: 'watchlist' } as RuleConditions, createdAt: r.createdAt }
}

export async function listRulesWithHits(): Promise<{ rules: AlertRule[]; hits: RuleHit[] }> {
  const rules = (await rulesRepo.listRules()).map(rowToRule)
  const nameById = new Map(rules.map((r) => [r.id, r.name]))
  const hits = (await rulesRepo.recentHits(30)).map((h) => ({
    id: h.id,
    ruleId: h.ruleId,
    ruleName: nameById.get(h.ruleId) ?? null,
    symbol: h.symbol,
    date: h.date,
    detail: (h.detail ?? {}) as Record<string, unknown>,
    notified: h.notified,
    createdAt: h.createdAt,
  }))
  return { rules, hits }
}

export async function createRule(name: string, conditions: RuleConditions): Promise<AlertRule> {
  return rowToRule(await rulesRepo.insertRule(name, conditions, new Date().toISOString()))
}

export async function setRuleEnabled(id: number, enabled: boolean): Promise<void> {
  await rulesRepo.setEnabled(id, enabled)
}

export async function deleteRule(id: number): Promise<void> {
  await rulesRepo.removeRule(id)
}

// ——— Per-symbol facts (computed once per evaluation) ———

interface Facts {
  date: string // the symbol's latest session
  close: number
  move1d: number // %
  volSpike: number // today's volume ÷ trailing 20-session avg
  liqCr: number // avg daily traded value, ₹ crore
}

const pc = (a: number, b: number) => (b ? ((a - b) / b) * 100 : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/** Same data shaping as guidance/scan.ts prescreen(): one bulk read of the last
 *  ~45 sessions, grouped per symbol. Symbols with <20 sessions are skipped (their
 *  volume averages are meaningless for spike detection). */
async function computeFacts(): Promise<Map<string, Facts>> {
  const facts = new Map<string, Facts>()
  const dates = await pricesRepo.distinctRecentDates(45)
  if (dates.length < 6) return facts
  const rows = await pricesRepo.since(dates[dates.length - 1])

  const by = new Map<string, { date: string; close: number; volume: number }[]>()
  for (const r of rows) {
    const arr = by.get(r.symbol) ?? []
    if (!by.has(r.symbol)) by.set(r.symbol, arr)
    arr.push({ date: r.date, close: r.close, volume: r.volume })
  }

  for (const [symbol, series] of by) {
    if (series.length < 20) continue
    const c = series.map((s) => s.close)
    const v = series.map((s) => s.volume)
    const px = c[c.length - 1]
    const prev = c[c.length - 2]
    if (!px || !prev) continue
    const avg20v = v.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, v.length)
    facts.set(symbol, {
      date: series[series.length - 1].date,
      close: px,
      move1d: round2(pc(px, prev)),
      volSpike: round2(avg20v ? v[v.length - 1] / avg20v : 1),
      liqCr: round2((avg20v * px) / 1e7),
    })
  }
  return facts
}

// ——— Matching ———

/** Cheap numeric conditions only — news/filings are checked afterwards so their
 *  (rarer) lookups run against a much smaller survivor set. */
function matchesNumeric(c: RuleConditions, f: Facts): boolean {
  if (c.move1dPct) {
    const ok = c.move1dPct.op === '<=' ? f.move1d <= c.move1dPct.value : f.move1d >= c.move1dPct.value
    if (!ok) return false
  }
  if (c.volSpikeX != null && f.volSpike < c.volSpikeX) return false
  if (c.minLiqCrore != null && f.liqCr < c.minLiqCrore) return false
  return true
}

function filingMatches(materiality: 'high' | 'medium' | undefined, level: string): boolean {
  if (materiality === 'high') return level === 'high'
  if (materiality === 'medium') return level !== 'low' // medium = medium-or-above
  return true
}

// A degenerate rule (e.g. minLiqCrore alone) can match hundreds of names; cap what
// one rule may insert per run so a misconfiguration can't flood the table + email.
const MAX_HITS_PER_RULE = 100

// Single-flight: the 18:50 cron and a manual POST /run could overlap; the unique
// index makes that harmless for storage, but two evaluators would double-email.
let evaluating = false

/** Evaluate all enabled rules against the freshest price store, persist new hits
 *  (idempotent) and email one combined summary. Never throws; returns new-hit count. */
export async function evaluateAlertRules(): Promise<{ hits: number }> {
  if (evaluating) return { hits: 0 }
  evaluating = true
  try {
    const rules = (await rulesRepo.enabledRules()).map(rowToRule).filter((r) => ruleConditionsSchema.safeParse(r.conditions).success)
    if (rules.length === 0) {
      console.log('[alert-rules] no enabled rules — nothing to evaluate')
      return { hits: 0 }
    }
    const facts = await computeFacts()
    if (facts.size === 0) {
      console.log('[alert-rules] price store too thin to evaluate — skipping')
      return { hits: 0 }
    }

    // Shared lookups, fetched at most once per evaluation regardless of rule count.
    let watchSet: Set<string> | null = null
    if (rules.some((r) => r.conditions.universe === 'watchlist')) {
      // 'watchlist' = union of synced account watchlists + the guidance watch universe.
      const [accounts, guidance] = await Promise.all([
        watchlistsRepo.allSymbols().catch(() => [] as string[]),
        guidanceWatchlistRepo.list().catch(() => []),
      ])
      watchSet = new Set([...accounts, ...guidance.map((w) => w.symbol)].map((s) => s.toUpperCase()))
    }
    let newsSet: Set<string> | null = null
    if (rules.some((r) => r.conditions.noNews)) {
      const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString()
      newsSet = new Set((await newsRepo.tickersWithNewsSince(cutoff)).map((s) => s.toUpperCase()))
    }
    let filingsBySym: Map<string, { title: string; materiality: string; filedAt: string }[]> | null = null
    if (rules.some((r) => r.conditions.hasFiling)) {
      // One bulk read (newest-first) instead of a per-symbol query; 800 rows comfortably
      // covers the ≤30-day windows rules are allowed to ask for.
      filingsBySym = new Map()
      for (const f of await filingsRepo.latest(800)) {
        if (!f.symbol) continue
        const arr = filingsBySym.get(f.symbol) ?? []
        if (!filingsBySym.has(f.symbol)) filingsBySym.set(f.symbol, arr)
        arr.push({ title: f.title, materiality: f.materiality, filedAt: f.filedAt })
      }
    }

    const now = new Date().toISOString()
    const toInsert: { ruleId: number; symbol: string; date: string; detail: unknown; createdAt: string }[] = []
    for (const rule of rules) {
      const c = rule.conditions
      let count = 0
      for (const [symbol, f] of facts) {
        if (count >= MAX_HITS_PER_RULE) break
        if (c.universe === 'watchlist' && !watchSet!.has(symbol)) continue
        if (!matchesNumeric(c, f)) continue
        if (c.noNews && newsSet!.has(symbol)) continue
        let filing: { title: string; materiality: string; filedAt: string } | null = null
        if (c.hasFiling) {
          const cutoff = new Date(Date.now() - c.hasFiling.withinDays * 86_400_000).toISOString()
          filing = (filingsBySym!.get(symbol) ?? []).find((x) => x.filedAt >= cutoff && filingMatches(c.hasFiling!.materiality, x.materiality)) ?? null
          if (!filing) continue
        }
        toInsert.push({
          ruleId: rule.id,
          symbol,
          date: f.date,
          detail: { close: f.close, move1d: f.move1d, volSpike: f.volSpike, liqCr: f.liqCr, ...(filing ? { filing } : {}) },
          createdAt: now,
        })
        count++
      }
    }

    const inserted = await rulesRepo.insertHits(toInsert)
    console.log(`[alert-rules] evaluated ${rules.length} rule(s) over ${facts.size} symbols — ${inserted.length} new hit(s) (${toInsert.length} matched)`)
    if (inserted.length > 0) await emailNewHits(rules)
    return { hits: inserted.length }
  } catch (e) {
    console.warn('[alert-rules] evaluation failed:', (e as Error).message)
    return { hits: 0 }
  } finally {
    evaluating = false
  }
}

// ——— Email delivery (same recipients as the guidance digest) ———

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pctFmt = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

/** Mail every not-yet-notified hit as one combined summary; mark them notified
 *  only when the send actually succeeded (an SMTP hiccup retries next run). */
async function emailNewHits(rules: AlertRule[]): Promise<void> {
  if (!mailConfigured()) {
    console.log('[alert-rules] SMTP not configured — hits stored, email skipped')
    return
  }
  const to = digestRecipients()
  if (to.length === 0) {
    console.warn('[alert-rules] no recipients (DIGEST_TO / GUIDANCE_OWNER_EMAILS) — email skipped')
    return
  }
  const pending = await rulesRepo.unnotified(200)
  if (pending.length === 0) return
  const nameById = new Map(rules.map((r) => [r.id, r.name]))
  const day = istDay()

  const rowHtml = (h: rulesRepo.HitRow) => {
    const d = (h.detail ?? {}) as { close?: number; move1d?: number; volSpike?: number; filing?: { title: string; materiality: string } }
    const bits = [
      d.close != null ? `₹${d.close.toLocaleString('en-IN')}` : '',
      d.move1d != null ? `1d <span style="color:${d.move1d >= 0 ? '#1a7f37' : '#c62828'}">${pctFmt(d.move1d)}</span>` : '',
      d.volSpike != null ? `${d.volSpike.toFixed(1)}× vol` : '',
      d.filing ? `filing [${esc(d.filing.materiality)}]: ${esc(d.filing.title.slice(0, 120))}` : '',
    ].filter(Boolean).join(' · ')
    return `<tr><td style="padding:8px 0;border-top:1px solid #eee">
      <div style="font-size:14px"><strong>${esc(h.symbol)}</strong> <span style="color:#666;font-size:12px">${esc(h.date)}</span>
        <span style="background:#1565c0;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:6px">${esc(nameById.get(h.ruleId) ?? `rule #${h.ruleId}`)}</span>
      </div>
      <div style="font-size:12px;color:#444;margin-top:2px">${bits}</div>
    </td></tr>`
  }

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
    <div style="background:#fff;border-radius:12px;padding:24px">
      <h1 style="font-size:18px;margin:0 0 4px">Bharat Market Pro — custom rule alerts</h1>
      <div style="color:#666;font-size:12px;margin:0 0 12px">${day} · ${pending.length} hit(s) across your rules</div>
      <table style="border-collapse:collapse;width:100%">${pending.map(rowHtml).join('')}</table>
      <div style="color:#999;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:12px">
        Rule-based alerts evaluated against the latest NSE bhavcopy.
      </div>
    </div>
  </div></body></html>`

  const text = pending
    .map((h) => {
      const d = (h.detail ?? {}) as { move1d?: number; volSpike?: number }
      return `${h.symbol} ${h.date} [${nameById.get(h.ruleId) ?? h.ruleId}]${d.move1d != null ? ` ${pctFmt(d.move1d)} 1d` : ''}${d.volSpike != null ? ` ${d.volSpike.toFixed(1)}x vol` : ''}`
    })
    .join('\n')

  const sent = await sendMail({ to, subject: `Bharat Market Pro alerts — ${pending.length} rule hits — ${day}`, html, text })
  if (sent) await rulesRepo.markNotified(pending.map((h) => h.id))
}
