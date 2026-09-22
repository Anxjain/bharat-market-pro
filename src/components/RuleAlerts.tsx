// Rule-based custom alerts (9.7) — beyond simple price thresholds. One compact
// card: the saved rules (toggle/delete/run-now), a create form over the condition
// fields (move %, volume spike, liquidity, no-news, filings) and the recent hits.
// Evaluated server-side every evening against the fresh bhavcopy; fetches are kept
// local to this component (the rules API is used nowhere else).

import { useCallback, useEffect, useState } from 'react'
import { BellPlus, Play, X } from 'lucide-react'
import { SectionTitle } from './ui'
import { useToast } from '../lib/toast'
import { authHeader } from '../lib/token'

interface RuleConditions {
  universe: 'all' | 'watchlist'
  move1dPct?: { op: '<=' | '>='; value: number }
  volSpikeX?: number
  minLiqCrore?: number
  noNews?: boolean
  hasFiling?: { materiality?: 'high' | 'medium'; withinDays: number }
}

interface AlertRule {
  id: number
  name: string
  enabled: boolean
  conditions: RuleConditions
  createdAt: string
}

interface RuleHit {
  id: number
  ruleId: number
  ruleName: string | null
  symbol: string
  date: string
  detail: { close?: number; move1d?: number; volSpike?: number; filing?: { title: string; materiality: string } }
}

function describe(c: RuleConditions): string {
  const bits: string[] = [c.universe === 'all' ? 'NIFTY 500' : 'watchlist']
  if (c.move1dPct) bits.push(`1d ${c.move1dPct.op === '<=' ? '≤' : '≥'} ${c.move1dPct.value}%`)
  if (c.volSpikeX != null) bits.push(`vol ≥ ${c.volSpikeX}× avg`)
  if (c.minLiqCrore != null) bits.push(`liq ≥ ₹${c.minLiqCrore}cr`)
  if (c.noNews) bits.push('no news 2d')
  if (c.hasFiling) bits.push(`${c.hasFiling.materiality ?? 'any'} filing ≤${c.hasFiling.withinDays}d`)
  return bits.join(' · ')
}

export function RuleAlerts() {
  const { toast } = useToast()
  const [rules, setRules] = useState<AlertRule[]>([])
  const [hits, setHits] = useState<RuleHit[]>([])
  const [busy, setBusy] = useState(false)

  // Create-form state (empty string = condition not included).
  const [name, setName] = useState('')
  const [universe, setUniverse] = useState<'all' | 'watchlist'>('all')
  const [moveOp, setMoveOp] = useState<'<=' | '>='>('<=')
  const [movePct, setMovePct] = useState('')
  const [volX, setVolX] = useState('')
  const [minLiq, setMinLiq] = useState('')
  const [noNews, setNoNews] = useState(false)
  const [filing, setFiling] = useState<'' | 'any' | 'medium' | 'high'>('')
  const [filingDays, setFilingDays] = useState('3')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/alert-rules', { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return
      const d = (await res.json()) as { rules: AlertRule[]; hits: RuleHit[] }
      setRules(d.rules ?? [])
      setHits(d.hits ?? [])
    } catch { /* leave last known state */ }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  async function create() {
    if (busy) return
    const conditions: RuleConditions = { universe }
    if (movePct !== '' && !Number.isNaN(Number(movePct))) conditions.move1dPct = { op: moveOp, value: Number(movePct) }
    if (volX !== '' && Number(volX) > 0) conditions.volSpikeX = Number(volX)
    if (minLiq !== '' && Number(minLiq) > 0) conditions.minLiqCrore = Number(minLiq)
    if (noNews) conditions.noNews = true
    if (filing !== '') conditions.hasFiling = { ...(filing !== 'any' ? { materiality: filing } : {}), withinDays: Math.max(1, Math.min(30, Number(filingDays) || 3)) }
    setBusy(true)
    try {
      const res = await fetch('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ name: name.trim(), conditions }),
      })
      if (res.status === 401) { toast('Sign in to create alert rules.'); setBusy(false); return }
      if (res.ok) {
        toast(`Rule "${name.trim()}" saved — evaluated every evening after the price ingest.`, 'success')
        setName(''); setMovePct(''); setVolX(''); setMinLiq(''); setNoNews(false); setFiling('')
        refresh()
      } else {
        const d = (await res.json().catch(() => null)) as { error?: string } | null
        toast(d?.error ?? 'Could not save the rule.')
      }
    } catch {
      toast('Network error — the rule was not saved.')
    }
    setBusy(false)
  }

  async function runNow() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/alert-rules/run', { method: 'POST', headers: authHeader(), signal: AbortSignal.timeout(60_000) })
      const d = (await res.json().catch(() => null)) as { hits?: number } | null
      toast(res.ok ? `Rules evaluated — ${d?.hits ?? 0} new hit(s).` : 'Evaluation failed.', res.ok ? 'success' : undefined)
      refresh()
    } catch {
      toast('Network error — could not run the rules.')
    }
    setBusy(false)
  }

  const inputCls = 'rounded-full border border-line bg-panel px-2.5 py-1 text-[11.5px] focus:border-line focus:bg-surface focus:outline-none'

  return (
    <div className="card mt-6 p-5">
      <SectionTitle
        right={
          rules.length > 0 ? (
            <button onClick={runNow} disabled={busy} className="flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[10.5px] font-bold text-muted transition-colors hover:text-strong">
              <Play size={10} /> Run now
            </button>
          ) : undefined
        }
      >
        Custom rule alerts
      </SectionTitle>
      <p className="mb-3 text-[11.5px] text-faint">
        Screen-style alerts (price move + volume + news + filings, AND-ed together) checked every evening against the fresh NSE closes and emailed to you.
      </p>

      {/* Create form */}
      <form onSubmit={(e) => { e.preventDefault(); create() }} className="flex flex-wrap items-center gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name" className={`${inputCls} w-36`} />
        <select value={universe} onChange={(e) => setUniverse(e.target.value as 'all' | 'watchlist')} className={inputCls}>
          <option value="all">NIFTY 500</option>
          <option value="watchlist">Watchlist</option>
        </select>
        <span className="flex items-center gap-1">
          <select value={moveOp} onChange={(e) => setMoveOp(e.target.value as '<=' | '>=')} className={inputCls}>
            <option value="<=">1d ≤</option>
            <option value=">=">1d ≥</option>
          </select>
          <input value={movePct} onChange={(e) => setMovePct(e.target.value.replace(/[^0-9.-]/g, ''))} placeholder="e.g. -6" inputMode="decimal" className={`${inputCls} w-16`} title="1-day move threshold (%)" />
          <span className="text-[11px] text-faint">%</span>
        </span>
        <span className="flex items-center gap-1">
          <input value={volX} onChange={(e) => setVolX(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="vol ×" inputMode="decimal" className={`${inputCls} w-14`} title="Volume ≥ this × the 20-session average" />
          <span className="text-[11px] text-faint">× avg vol</span>
        </span>
        <span className="flex items-center gap-1">
          <input value={minLiq} onChange={(e) => setMinLiq(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="min liq" inputMode="decimal" className={`${inputCls} w-16`} title="Minimum average daily traded value (₹ crore)" />
          <span className="text-[11px] text-faint">₹cr</span>
        </span>
        <label className="flex cursor-pointer items-center gap-1 text-[11.5px] text-muted">
          <input type="checkbox" checked={noNews} onChange={(e) => setNoNews(e.target.checked)} className="accent-[#2ebd85]" /> no news (2d)
        </label>
        <span className="flex items-center gap-1">
          <select value={filing} onChange={(e) => setFiling(e.target.value as typeof filing)} className={inputCls} title="Require a recent exchange filing">
            <option value="">no filing filter</option>
            <option value="any">any filing</option>
            <option value="medium">medium+ filing</option>
            <option value="high">high-materiality filing</option>
          </select>
          {filing !== '' && (
            <>
              <span className="text-[11px] text-faint">within</span>
              <input value={filingDays} onChange={(e) => setFilingDays(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className={`${inputCls} w-11`} />
              <span className="text-[11px] text-faint">d</span>
            </>
          )}
        </span>
        <button type="submit" disabled={!name.trim() || busy} className="btn btn-red !px-3 !py-1.5 !text-[11px]">
          <BellPlus size={12} /> Save rule
        </button>
      </form>

      {/* Rules */}
      <div className="mt-3 space-y-1">
        {rules.length === 0 && (
          <p className="text-[11.5px] italic text-faint">No rules yet — e.g. "1d ≤ -6% on ≥2× avg volume with no news", or "watchlist name with a high-materiality filing".</p>
        )}
        {rules.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-panel">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-strong">{r.name}</span>
              <span className="block truncate text-[10.5px] text-faint">{describe(r.conditions)}</span>
            </span>
            <button
              onClick={async () => {
                await fetch(`/api/alert-rules/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ enabled: !r.enabled }) }).catch(() => null)
                refresh()
              }}
              role="switch"
              aria-checked={r.enabled}
              aria-label={r.enabled ? 'Disable rule' : 'Enable rule'}
              className={`h-4 w-7 rounded-full p-0.5 transition-colors ${r.enabled ? 'bg-[#2ebd85]' : 'bg-line'}`}
              title={r.enabled ? 'Disable' : 'Enable'}
            >
              <span className={`block h-3 w-3 rounded-full bg-surface shadow transition-transform duration-200 ${r.enabled ? 'translate-x-3' : ''}`} />
            </button>
            <button
              onClick={async () => { await fetch(`/api/alert-rules/${r.id}`, { method: 'DELETE', headers: authHeader() }).catch(() => null); refresh() }}
              className="flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-down-soft hover:text-down"
              title="Delete rule"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Recent hits */}
      {hits.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-faint">Recent hits</div>
          {hits.slice(0, 8).map((h) => (
            <div key={h.id} className="flex items-baseline gap-2 px-1.5 py-1 text-[11.5px] text-muted">
              <span className="font-semibold text-strong">{h.symbol}</span>
              <span className="min-w-0 flex-1 truncate">
                {h.ruleName ?? `rule #${h.ruleId}`}
                {h.detail.move1d != null && ` · ${h.detail.move1d > 0 ? '+' : ''}${h.detail.move1d.toFixed(1)}% 1d`}
                {h.detail.volSpike != null && ` · ${h.detail.volSpike.toFixed(1)}× vol`}
                {h.detail.filing && ` · ${h.detail.filing.title.slice(0, 60)}`}
              </span>
              <span className="text-[10px] text-faint">{h.date}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
