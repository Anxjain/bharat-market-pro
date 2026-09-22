// ULIP Insurance Monitor explorer — renders entirely from /api/ulip (Postgres).
// Data from insurer public factsheets.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, Layers, GitCompareArrows, ShieldCheck, Table2, Sparkles, Send, Globe, Search, RefreshCw, TrendingUp, Upload } from 'lucide-react'
import { useDebounced } from '../../lib/hooks'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { TabButton } from '../ui'
import { DataSourceBadge } from '../DataSourceBadge'
import { FactsheetUpload } from './FactsheetUpload'
import { MarkdownLite } from '../MarkdownLite'
import { changeColor } from '../../lib/format'
import {
  useUlipInsurers, useUlipFunds, useUlipFund, useFundHistory,
  useConsolidatedSymbols, useConsolidated, useQuarantine, useFundMoM, fetchCompare, exportUrls,
  fetchUlipChat, triggerUlipRefresh, getRefreshStatus, useUlipAdmin,
  type UlipFund, type CompareEntry, type InsurerFreshness, type MoMChange, type UlipChatMsg, type RefreshState,
  type FundHistory, type HistoryPoint,
} from '../../lib/ulip'

const PERIOD_ORDER = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', 'Inception']
const orderPeriods = (ps: string[]) => [
  ...PERIOD_ORDER.filter((p) => ps.includes(p)),
  ...ps.filter((p) => !PERIOD_ORDER.includes(p)),
]
const num = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: d }))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}%`)

function StatusTag({ status }: { status: string }) {
  if (status === 'suspicious')
    return <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[#c4762a]">Unverified</span>
  if (status === 'failed')
    return <span className="rounded-full bg-down-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-down">Quarantined</span>
  return <span className="rounded-full bg-up-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-up">Verified</span>
}

function ExportBtn({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-bold text-muted shadow-sm transition-colors hover:border-inkfill hover:text-ink"
    >
      <Download size={12} /> {label}
    </a>
  )
}

function AsOf({ month }: { month: string | null }) {
  return (
    <p className="mt-1 text-[11px] italic text-faint">
      Data sourced from insurer public factsheets{month ? `, as-of ${month}` : ''}.
    </p>
  )
}

// ————————————————————— Shared fund-browser (Funds + Trends tabs) —————————————————————
type BrowserInsurer = { code: string; name: string; status: string }
const insurerShortName = (insurers: BrowserInsurer[], code: string | null) =>
  code ? (insurers.find((i) => i.code === code)?.name ?? code).replace(/ (Life )?Insurance.*/, '') : ''

// Encapsulates the bank / fund-type / debounced-search state, the memoised filtered
// list, the default bank + default selection, shared by FundsTab and TrendsTab.
// `bank` is controlled by the parent because the two tabs fetch funds off it differently.
function useFundBrowser({ insurers, allFunds, bank, setBank, month }: {
  insurers: BrowserInsurer[]
  allFunds: UlipFund[]
  bank: string | null
  setBank: (b: string | null) => void
  month: string
}) {
  const active = useMemo(() => insurers.filter((i) => i.status === 'active'), [insurers])
  const [category, setCategory] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sfin, setSfin] = useState<string | null>(null)
  // Debounce the search so the fund-detail fetch doesn't fire on every keystroke (H-17).
  const debounced = useDebounced(query, 220)

  // Default the bank to the first insurer that actually has funds this month.
  useEffect(() => {
    if (bank === null && allFunds.length > 0) {
      const codes = new Set(allFunds.map((f) => f.insurer))
      const first = active.find((i) => codes.has(i.code))
      if (first) setBank(first.code)
    }
  }, [allFunds, bank, active, setBank])

  const q = debounced.trim().toLowerCase()
  const searching = q.length > 0
  const categories = useMemo(
    () => [...new Set(allFunds.filter((f) => f.insurer === bank && f.category).map((f) => f.category as string))].sort(),
    [allFunds, bank],
  )
  // Searching matches name OR SFIN across every insurer; otherwise filter by bank + type.
  const filtered = useMemo(
    () => allFunds.filter((f) =>
      searching
        ? f.name.toLowerCase().includes(q) || f.sfin.toLowerCase().includes(q)
        : f.insurer === bank && (!category || f.category === category)),
    [allFunds, searching, q, bank, category],
  )

  // Reset selection only when the SETTLED filter changes (not per keystroke)…
  useEffect(() => { setSfin(null) }, [bank, category, month, q])
  // …then select the first fund once the filter settles.
  useEffect(() => { if (!sfin && filtered.length > 0) setSfin(filtered[0].sfin) }, [filtered, sfin])

  return { active, category, setCategory, query, setQuery, searching, categories, filtered, sfin, setSfin }
}

const browserSelectCls = 'rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-strong outline-none focus:border-[#7a5cff] disabled:opacity-50'

// The bank / fund-type / search controls row, shared by both tabs.
function FundControls({ insurers, active, bank, setBank, browser, extra }: {
  insurers: BrowserInsurer[]
  active: BrowserInsurer[]
  bank: string | null
  setBank: (b: string | null) => void
  browser: ReturnType<typeof useFundBrowser>
  extra?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Insurer / Bank</span>
        <select value={bank ?? ''} onChange={(e) => { setBank(e.target.value || null); browser.setCategory(null); browser.setQuery('') }} className={browserSelectCls}>
          {active.map((i) => <option key={i.code} value={i.code}>{insurerShortName(insurers, i.code)}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Fund type</span>
        <select value={browser.category ?? ''} onChange={(e) => browser.setCategory(e.target.value || null)} disabled={browser.searching} className={browserSelectCls}>
          <option value="">All types</option>
          {browser.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="flex min-w-[240px] flex-1 flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-faint">Search — fund name or SFIN code</span>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-[#7a5cff]">
          <Search size={14} className="shrink-0 text-faint" />
          <input value={browser.query} onChange={(e) => browser.setQuery(e.target.value)} placeholder="e.g. Bluechip, Equity, or ULIF001…" className="w-full text-[13px] text-strong outline-none" />
          {browser.query && <button onClick={() => browser.setQuery('')} className="shrink-0 text-[11px] text-faint hover:text-muted">clear</button>}
        </div>
      </label>
      {extra}
    </div>
  )
}

// The scrollable left-hand fund list, shared by both tabs.
function FundList({ insurers, browser, loading, maxH, onPick }: {
  insurers: BrowserInsurer[]
  browser: ReturnType<typeof useFundBrowser>
  loading: boolean
  maxH: string
  onPick?: (sfin: string) => void
}) {
  const { filtered, sfin, searching, setSfin } = browser
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-sm">
      {loading && <p className="p-4 text-[12px] italic text-faint">Loading funds…</p>}
      {!loading && filtered.length === 0 && <p className="p-4 text-[12px] italic text-faint">No funds match.</p>}
      <div className={`${maxH} divide-y divide-[#f0f1f4] overflow-auto`}>
        {filtered.map((f) => (
          <button
            key={f.sfin}
            onClick={() => { setSfin(f.sfin); onPick?.(f.sfin) }}
            className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-panel ${sfin === f.sfin ? 'bg-accent-soft' : ''}`}
          >
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-medium text-ink">{f.name}</span>
              <span className="block truncate font-mono text-[10px] text-faint">{f.sfin}</span>
              <span className="text-[10.5px] uppercase tracking-wide text-faint">{searching ? insurerShortName(insurers, f.insurer) + ' · ' : ''}{f.category ?? '—'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-[12px] text-muted">{num(f.nav)}</span>
              <StatusTag status={f.status} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ——————————————————————————————— Funds tab ———————————————————————————————
function FundsTab({ month, insurers }: {
  month: string
  insurers: { code: string; name: string; status: string; latestStored: string | null }[]
}) {
  // Load the best-available month PER insurer (best=1): an insurer whose data lags the
  // globally-selected month (e.g. ICICI ends May while July is picked) still shows its
  // newest funds instead of vanishing. Each fund carries its own `month`.
  const { funds: allFunds, loading } = useUlipFunds(null, month, null, true)
  const [bank, setBank] = useState<string | null>(null)
  const browser = useFundBrowser({ insurers, allFunds, bank, setBank, month })
  // Detail + export use the SELECTED fund's / bank's own month, not the global picker.
  const pickedFund = allFunds.find((f) => f.sfin === browser.sfin)
  const detailMonth = pickedFund?.month ?? month
  const bankMonth = bank ? (allFunds.find((f) => f.insurer === bank)?.month ?? month) : month
  const { detail } = useUlipFund(browser.sfin, detailMonth)
  const [showAllHoldings, setShowAllHoldings] = useState(false)

  return (
    <div>
      <FundControls
        insurers={insurers}
        active={browser.active}
        bank={bank}
        setBank={setBank}
        browser={browser}
        extra={!browser.searching && bank ? <div className="pb-0.5"><ExportBtn href={exportUrls.company(bank, bankMonth)} label="Export (xlsx)" /></div> : undefined}
      />

      <div className="mt-2 text-[11px] text-faint">
        {browser.searching
          ? `${browser.filtered.length} match${browser.filtered.length === 1 ? '' : 'es'} across all insurers for “${browser.query}”`
          : `${browser.filtered.length} funds · ${insurerShortName(insurers, bank)}${browser.category ? ` · ${browser.category}` : ''}`}
        {!browser.searching && bank && bankMonth !== month && (
          <span className="ml-1 rounded bg-warn-soft px-1.5 py-0.5 font-medium text-[#b7791f]">latest available: {monthLabel(bankMonth)} (no {monthLabel(month)} data yet)</span>
        )}
      </div>

      <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <FundList insurers={insurers} browser={browser} loading={loading} maxH="max-h-[560px]" onPick={() => setShowAllHoldings(false)} />

        {/* fund detail */}
        <div>
          {!detail && <p className="text-[13px] italic text-faint">Select a fund to see its detail.</p>}
          {detail && <FundDetailPanel detail={detail} showAll={showAllHoldings} setShowAll={setShowAllHoldings} />}
        </div>
      </div>
    </div>
  )
}

function MoMBlock({ sfin, month }: { sfin: string; month: string }) {
  const mom = useFundMoM(sfin, month)
  if (!mom) return null
  if (!mom.hasPrev) return <div className="mt-5 text-[11px] italic text-faint">Month-over-month: no prior-month data ({mom.prevMonth}) to compare yet.</div>
  const section = (title: string, items: MoMChange[], color: string) =>
    items.length > 0 ? (
      <div key={title}>
        <div className="text-[10.5px] font-bold uppercase tracking-wide text-faint">{title}</div>
        <div className="mt-1 space-y-0.5">
          {items.slice(0, 6).map((c) => (
            <div key={c.security} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-muted">{c.security}</span>
              <span className={`shrink-0 font-mono ${color}`}>{c.delta > 0 ? '+' : ''}{c.delta.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>
    ) : null
  return (
    <div className="mt-5">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Month-over-month vs {mom.prevMonth}</div>
      <div className="grid gap-4 sm:grid-cols-2">
        {section(`Bought (${mom.added.length})`, mom.added, 'text-up')}
        {section(`Sold (${mom.removed.length})`, mom.removed, 'text-down')}
        {section('Increased', mom.increased, 'text-up')}
        {section('Trimmed', mom.decreased, 'text-down')}
      </div>
      {mom.added.length === 0 && mom.removed.length === 0 && mom.increased.length === 0 && mom.decreased.length === 0 && (
        <div className="text-[11px] italic text-faint">No position changes vs {mom.prevMonth}.</div>
      )}
    </div>
  )
}

type Section = 'performance' | 'allocation' | 'sector' | 'rating' | 'maturity' | 'portfolio'

function SectionEmpty({ what }: { what: string }) {
  return <p className="py-6 text-[12.5px] italic text-faint">No {what} reported in this fund's factsheet.</p>
}

// Small labelled stat tile in the Fund Details strip.
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-panel px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-ink">{value}</div>
    </div>
  )
}

function FundDetailPanel({ detail, showAll, setShowAll }: {
  detail: NonNullable<ReturnType<typeof useUlipFund>['detail']>
  showAll: boolean
  setShowAll: (v: boolean) => void
}) {
  const f = detail.fund
  const [section, setSection] = useState<Section>('performance')
  useEffect(() => { setSection('performance') }, [f.sfin])
  // Per-fund resolved source: exact PDF (deep-linked to this fund's page) or a live
  // webpage fallback. Falls back to the first raw source row for older API responses.
  const link = detail.sourceLink
  const linkHref = link ? link.href + (link.page ? `#page=${link.page}` : '') : detail.sources[0]?.url ?? ''
  const linkLabel = link?.label ?? 'raw source factsheet'

  // Asset allocation — VERBATIM labels exactly as the factsheet prints them (no bucketing).
  // Each row carries the F&U min/max band + the actual weight. Some parsers keep the band
  // in a separate 'fnu' bucket (same labels) — merge it in by label so Min/Max always shows.
  const fnuByLabel = new Map(detail.allocations.fnu.map((a) => [a.label, a]))
  const assetRows = detail.allocations.asset.map((a) => {
    const band = fnuByLabel.get(a.label)
    return { ...a, fuMin: a.fuMin ?? band?.fuMin ?? null, fuMax: a.fuMax ?? band?.fuMax ?? null }
  })
  const grandTotal = assetRows.reduce((s, r) => s + (r.weight ?? 0), 0)
  const hasBand = assetRows.some((a) => a.fuMin != null || a.fuMax != null)

  // Portfolio holdings grouped by their VERBATIM factsheet section (Equity / G-Sec /
  // Corporate Debt / Money Market / …) — never merged. Order by first appearance.
  const groups: { cat: string; rows: typeof detail.holdings; subtotal: number }[] = []
  for (const h of detail.holdings) {
    const cat = h.category ?? h.rawCategory ?? 'Holdings'
    let g = groups.find((x) => x.cat === cat)
    if (!g) { g = { cat, rows: [], subtotal: 0 }; groups.push(g) }
    g.rows.push(h); g.subtotal += h.weightPct ?? 0
  }
  const anyRating = detail.allocations.rating.length > 0
  const anyMaturity = detail.allocations.maturity.length > 0
  const hasIsin = detail.holdings.some((h) => h.isin)
  const hasRatingCol = detail.holdings.some((h) => h.rating)

  const allSections: { key: Section; label: string; n: number; show: boolean }[] = [
    { key: 'performance', label: 'Fund vs Benchmark', n: detail.returns.length, show: true },
    { key: 'allocation', label: 'Asset Allocation', n: assetRows.length, show: assetRows.length > 0 },
    { key: 'sector', label: 'Industry / Sector', n: detail.allocations.sector.length, show: detail.allocations.sector.length > 0 },
    { key: 'rating', label: 'Rating Profile', n: detail.allocations.rating.length, show: anyRating },
    { key: 'maturity', label: 'Maturity Profile', n: detail.allocations.maturity.length, show: anyMaturity },
    { key: 'portfolio', label: 'Portfolio', n: detail.holdings.length, show: true },
  ]
  const sections = allSections.filter((s) => s.show)

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[18px] font-medium text-ink">{f.name}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-faint">{f.sfin}{f.class ? ` · ${f.class}` : ''}</p>
        </div>
        <StatusTag status={f.status} />
      </div>

      {/* Fund Details — every header field the factsheet prints (blanks hidden) */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="NAV" value={<span className="text-[14px] font-bold">{num(f.nav, 4)}</span>} />
        <Stat label="AUM (Cr)" value={<span className="text-[14px] font-bold">{num(f.aumTotalCr)}</span>} />
        <Stat label="Inception" value={f.inception ?? '—'} />
        {f.ytm != null && <Stat label="YTM" value={pct(f.ytm)} />}
        {f.modifiedDuration != null && <Stat label="Mod. Duration" value={`${num(f.modifiedDuration)} yr`} />}
        <Stat label="Benchmark" value={f.benchmark ?? '—'} />
        <Stat label="Fund Manager(s)" value={f.manager ?? '—'} />
        {f.managedSummary && <Stat label="Funds Managed" value={f.managedSummary} />}
      </div>

      {/* Section selector — only sections this fund actually has */}
      <div className="mt-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-bold transition-colors ${section === s.key ? 'bg-inkfill text-white' : 'bg-panel text-muted hover:text-strong'}`}
          >
            {s.label} <span className={section === s.key ? 'text-white/60' : 'text-faint'}>{s.n}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-[180px]">
        {/* Fund vs Benchmark performance */}
        {section === 'performance' && (detail.returns.length === 0 ? <SectionEmpty what="returns data" /> : (
          <table className="w-full text-[12.5px]">
            <thead><tr className="border-b border-line text-left text-[9.5px] uppercase tracking-[0.12em] text-faint"><th className="pb-1.5 font-bold">Period</th><th className="pb-1.5 font-bold">Fund</th><th className="pb-1.5 font-bold">Benchmark</th></tr></thead>
            <tbody>
              {orderPeriods(detail.returns.map((r) => r.period)).map((p) => {
                const r = detail.returns.find((x) => x.period === p)!
                return (
                  <tr key={p} className="border-b border-line last:border-0">
                    <td className="py-1.5 text-muted">{p}</td>
                    <td className={`py-1.5 font-mono ${r.returnPct != null ? changeColor(r.returnPct) : ''}`}>{pct(r.returnPct)}</td>
                    <td className="py-1.5 font-mono text-muted">{pct(r.benchmarkPct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ))}

        {/* Asset allocation — verbatim labels, Min/Max F&U band + Actual, exactly as printed */}
        {section === 'allocation' && (assetRows.length === 0 ? <SectionEmpty what="asset allocation" /> : (
          <div className="space-y-1.5">
            {hasBand && (
              <div className="flex items-center gap-2 pb-1 text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
                <span className="w-44 shrink-0">Asset Type</span><span className="w-24 shrink-0 text-right">Min – Max</span><span className="flex-1" /><span className="w-16 text-right">Actual</span>
              </div>
            )}
            {assetRows.map((a) => (
              <div key={a.label} className="flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-[12.5px] text-muted" title={a.label}>{a.label}</span>
                {hasBand && <span className="w-24 shrink-0 text-right font-mono text-[11px] text-faint">{a.fuMin != null || a.fuMax != null ? `${a.fuMin ?? 0}–${a.fuMax ?? 100}%` : '—'}</span>}
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-panel"><span className="block h-full rounded-full bg-[#2186c4]" style={{ width: `${Math.min(100, a.weight ?? 0)}%` }} /></span>
                <span className="w-16 text-right font-mono text-[12px] text-strong">{pct(a.weight)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-line pt-2 text-[12.5px] font-bold text-ink">
              <span>Total</span><span className="font-mono">{pct(grandTotal)}</span>
            </div>
          </div>
        ))}

        {/* Industry / Sector exposure (verbatim NIC labels) */}
        {section === 'sector' && (detail.allocations.sector.length === 0 ? <SectionEmpty what="industry / sector exposure" /> : (
          <div className="space-y-1.5">
            {[...detail.allocations.sector].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="w-56 shrink-0 truncate text-[12px] text-muted" title={s.label}>{s.label}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-panel"><span className="block h-full rounded-full bg-[#7c8aa5]" style={{ width: `${Math.min(100, s.weight ?? 0)}%` }} /></span>
                <span className="w-14 text-right font-mono text-[12px] text-strong">{pct(s.weight)}</span>
              </div>
            ))}
          </div>
        ))}

        {/* Credit-rating profile (debt) */}
        {section === 'rating' && (
          <div className="space-y-1.5">
            {[...detail.allocations.rating].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-[12.5px] text-muted">{r.label}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-panel"><span className="block h-full rounded-full bg-[#3a9d6e]" style={{ width: `${Math.min(100, r.weight ?? 0)}%` }} /></span>
                <span className="w-14 text-right font-mono text-[12px] text-strong">{pct(r.weight)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Maturity profile (debt) */}
        {section === 'maturity' && (
          <div className="space-y-1.5">
            {detail.allocations.maturity.map((m) => (
              <div key={m.label} className="flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-[12.5px] text-muted">{m.label}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-panel"><span className="block h-full rounded-full bg-[#b08a3a]" style={{ width: `${Math.min(100, m.weight ?? 0)}%` }} /></span>
                <span className="w-14 text-right font-mono text-[12px] text-strong">{pct(m.weight)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Portfolio holdings — CATEGORIZED by verbatim factsheet section (never mixed) */}
        {section === 'portfolio' && (detail.holdings.length === 0 ? <SectionEmpty what="portfolio holdings" /> : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">{detail.holdings.length} holdings · {groups.length} {groups.length === 1 ? 'category' : 'categories'}</span>
              {detail.holdings.length > 25 && (
                <button onClick={() => setShowAll(!showAll)} className="text-[11px] font-bold text-[#2186c4] hover:underline">{showAll ? 'Collapse' : 'Expand all'}</button>
              )}
            </div>
            <div className="space-y-3">
              {groups.map((g) => {
                const rows = !showAll && detail.holdings.length > 25 ? g.rows.slice(0, 6) : g.rows
                return (
                  <div key={g.cat}>
                    <div className="mb-1 flex items-center justify-between rounded-lg bg-panel px-2.5 py-1">
                      <span className="text-[11.5px] font-bold text-ink">{g.cat}</span>
                      <span className="font-mono text-[11.5px] text-muted">{pct(g.subtotal)}</span>
                    </div>
                    <table className="w-full text-[12.5px]">
                      <tbody>
                        {rows.map((h, i) => (
                          <tr key={h.security + i} className="border-b border-line last:border-0">
                            <td className="py-1.5 text-strong">
                              {h.security}
                              {h.isin && <span className="ml-1.5 font-mono text-[10px] text-faint">{h.isin}</span>}
                            </td>
                            {hasRatingCol && <td className="py-1.5 text-right">{h.rating && <span className="rounded bg-up-soft px-1.5 py-0.5 font-mono text-[10px] text-up">{h.rating}</span>}</td>}
                            <td className="py-1.5 text-right">{h.normalizedSymbol && <span className="rounded bg-info-soft px-1.5 py-0.5 font-mono text-[10px] text-[#2186c4]">{h.normalizedSymbol}</span>}</td>
                            <td className="w-14 py-1.5 text-right font-mono text-muted">{pct(h.weightPct)}</td>
                          </tr>
                        ))}
                        {!showAll && detail.holdings.length > 25 && g.rows.length > 6 && (
                          <tr><td colSpan={hasRatingCol ? 4 : 3} className="py-1 text-[11px] italic text-faint">+{g.rows.length - 6} more in {g.cat}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
            {(hasIsin || hasRatingCol) && <p className="mt-2 text-[10.5px] text-faint">ISIN / rating shown where the factsheet publishes them.</p>}
            <MoMBlock sfin={f.sfin} month={f.month} />
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[11px] text-faint">As-of {f.month}{linkHref ? ' · ' : ''}{linkHref && <a href={linkHref} target="_blank" rel="noreferrer" className="text-[#2186c4] hover:underline" title={link?.type === 'pdf' ? 'Opens the archived factsheet PDF at this fund’s page' : 'Opens the insurer’s live factsheet page'}>{linkLabel}</a>}</span>
        {f.status === 'suspicious' && f.flags.length > 0 && (
          <span className="text-[10.5px] italic text-[#c4762a]">{f.flags.length} validation note(s)</span>
        )}
      </div>
    </div>
  )
}

// ——————————————————————————————— Compare tab ———————————————————————————————
function CompareTab({ month }: { month: string }) {
  const { funds } = useUlipFunds(null, month, null)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<CompareEntry[]>([])
  const [running, setRunning] = useState(false)
  const [query, setQuery] = useState('')

  const bySfin = useMemo(() => new Map(funds.map((f) => [f.sfin, f])), [funds])
  const toggle = (sfin: string) => setSelected((s) => (s.includes(sfin) ? s.filter((x) => x !== sfin) : s.length < 6 ? [...s, sfin] : s))
  const run = async () => { setRunning(true); setResult(await fetchCompare(selected, month)); setRunning(false) }

  const q = query.trim().toLowerCase()
  const matches = q ? funds.filter((f) => f.name.toLowerCase().includes(q) || f.sfin.toLowerCase().includes(q) || f.insurer.includes(q)).slice(0, 60) : funds.slice(0, 60)
  const periods = useMemo(() => orderPeriods([...new Set(result.flatMap((e) => e.returns.map((r) => r.period)))]), [result])
  const assets = useMemo(() => [...new Set(result.flatMap((e) => e.allocations.map((a) => a.label)))], [result])

  return (
    <div>
      <p className="text-[12.5px] text-muted">Search and pick up to 6 funds (any insurer) to compare returns + allocation side by side.</p>

      {/* selected chips */}
      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {selected.map((sfin) => (
            <span key={sfin} className="inline-flex items-center gap-1.5 rounded-full bg-inkfill px-2.5 py-1 text-[11px] font-bold text-white">
              {bySfin.get(sfin)?.name ?? sfin}
              <button onClick={() => toggle(sfin)} className="text-white/60 hover:text-white">✕</button>
            </span>
          ))}
        </div>
      )}

      {/* search + selectable list (same shape as the Funds tab) */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-[#7a5cff]">
        <Search size={14} className="shrink-0 text-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search funds by name or SFIN to add…" className="w-full text-[13px] text-strong outline-none" />
        {query && <button onClick={() => setQuery('')} className="shrink-0 text-[11px] text-faint hover:text-muted">clear</button>}
      </div>
      <div className="mt-2 max-h-56 divide-y divide-[#f0f1f4] overflow-auto rounded-xl border border-line bg-surface">
        {matches.map((f) => (
          <button key={f.sfin} onClick={() => toggle(f.sfin)} disabled={!selected.includes(f.sfin) && selected.length >= 6}
            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-panel disabled:opacity-40 ${selected.includes(f.sfin) ? 'bg-accent-soft' : ''}`}>
            <span className="min-w-0"><span className="block truncate font-medium text-ink">{f.name}</span><span className="font-mono text-[10px] text-faint">{f.insurer} · {f.sfin}</span></span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${selected.includes(f.sfin) ? 'border-[#7a5cff] text-[#7a5cff]' : 'border-line text-faint'}`}>{selected.includes(f.sfin) ? 'added' : 'add'}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button onClick={run} disabled={selected.length < 2 || running}
          className="rounded-full bg-inkfill px-4 py-1.5 text-[12px] font-bold text-white disabled:opacity-40">
          {running ? 'Comparing…' : `Compare ${selected.length || ''}`}
        </button>
        {selected.length > 0 && <button onClick={() => { setSelected([]); setResult([]) }} className="text-[12px] text-faint hover:text-muted">reset</button>}
        {selected.length >= 2 && <ExportBtn href={exportUrls.comparative(selected, month)} label="Export comparison (xlsx)" />}
      </div>

      {result.length > 0 && (
        <div className="mt-5 overflow-auto">
          <table className="w-full min-w-[520px] text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.1em] text-faint">
                <th className="pb-2 font-bold">Metric</th>
                {result.map((e) => <th key={e.fund.sfin} className="pb-2 font-bold">{e.fund.name}<div className="font-normal normal-case text-faint">{e.fund.insurer}</div></th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line"><td className="py-1.5 text-muted">NAV</td>{result.map((e) => <td key={e.fund.sfin} className="py-1.5 font-mono">{num(e.fund.nav, 4)}</td>)}</tr>
              <tr className="border-b border-line"><td className="py-1.5 text-muted">AUM (Cr)</td>{result.map((e) => <td key={e.fund.sfin} className="py-1.5 font-mono">{num(e.fund.aumTotalCr)}</td>)}</tr>
              <tr className="border-b border-line"><td className="py-1.5 text-muted">Benchmark</td>{result.map((e) => <td key={e.fund.sfin} className="py-1.5">{e.fund.benchmark ?? '—'}</td>)}</tr>
              {periods.map((p) => (
                <tr key={p} className="border-b border-line">
                  <td className="py-1.5 text-muted">Return {p}</td>
                  {result.map((e) => { const r = e.returns.find((x) => x.period === p); return <td key={e.fund.sfin} className={`py-1.5 font-mono ${r?.returnPct != null ? changeColor(r.returnPct) : ''}`}>{pct(r?.returnPct ?? null)}</td> })}
                </tr>
              ))}
              {assets.map((l) => (
                <tr key={l} className="border-b border-line">
                  <td className="py-1.5 text-muted">{l} %</td>
                  {result.map((e) => { const a = e.allocations.find((x) => x.label === l); return <td key={e.fund.sfin} className="py-1.5 font-mono">{pct(a?.weight ?? null)}</td> })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ———————————————————— Consolidated tab (flagship) ————————————————————
function ConsolidatedTab({ month }: { month: string }) {
  const symbols = useConsolidatedSymbols(month)
  const [symbol, setSymbol] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const { holders, loading } = useConsolidated(symbol, month)
  useEffect(() => { if (!symbol && symbols.length) setSymbol(symbols[0].symbol) }, [symbols, symbol])
  const picked = symbols.find((s) => s.symbol === symbol)
  const q = query.trim().toLowerCase()
  const filteredSymbols = q ? symbols.filter((s) => s.symbol.toLowerCase().includes(q) || (s.company ?? '').toLowerCase().includes(q)) : symbols

  return (
    <div>
      <div className="rounded-2xl border border-inkfill/10 bg-gradient-to-br from-[#f4f8fb] to-white p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-inkfill text-white"><Layers size={14} /></span>
          <h3 className="text-[15px] font-bold text-ink">Consolidated cross-insurer holdings</h3>
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] text-muted">Pick a stock to see which insurers and ULIP funds hold it, and at what weight — joined to the NSE instruments master.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-[#7a5cff]">
            <Search size={14} className="shrink-0 text-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stock by symbol or name…" className="w-48 text-[13px] text-strong outline-none" />
            {query && <button onClick={() => setQuery('')} className="shrink-0 text-[11px] text-faint hover:text-muted">clear</button>}
          </div>
          <select value={symbol ?? ''} onChange={(e) => setSymbol(e.target.value || null)} className="min-w-64 rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-strong">
            <option value="">Select a stock… ({filteredSymbols.length})</option>
            {filteredSymbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol}{s.company ? ` — ${s.company}` : ''} ({s.holders} fund{s.holders === 1 ? '' : 's'})</option>)}
          </select>
          <ExportBtn href={exportUrls.consolidated(month)} label="Export consolidated (xlsx)" />
        </div>
      </div>

      {symbol && (
        <div className="mt-5">
          <div className="mb-2 flex items-baseline gap-2">
            <h4 className="text-[16px] font-medium text-ink">{picked?.company ?? symbol}</h4>
            <span className="font-mono text-[11px] text-faint">{symbol}</span>
          </div>
          {loading && <p className="text-[12px] italic text-faint">Loading…</p>}
          {!loading && holders.length === 0 && <p className="text-[12px] italic text-faint">No visible fund holds this security this month.</p>}
          {holders.length > 0 && (
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-line text-left text-[9.5px] uppercase tracking-[0.12em] text-faint"><th className="pb-2 font-bold">Insurer</th><th className="pb-2 font-bold">Fund</th><th className="pb-2 font-bold">As printed</th><th className="pb-2 text-right font-bold">Weight</th></tr></thead>
              <tbody>
                {holders.map((h) => (
                  <tr key={h.sfin} className="border-b border-line last:border-0">
                    <td className="py-2 font-medium text-strong">{h.insurerName ?? h.insurer}</td>
                    <td className="py-2 text-muted">{h.fundName}</td>
                    <td className="py-2 text-[11.5px] text-faint">{h.security}</td>
                    <td className="py-2 text-right font-mono text-strong">{pct(h.weightPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ——————————————————————————————— QA tab ———————————————————————————————
function QaTab({ month, insurers }: { month: string; insurers: InsurerFreshness[] }) {
  const quarantine = useQuarantine(month)
  const [job, setJob] = useState<RefreshState | null>(null)
  const [note, setNote] = useState('')

  // Fetch the current job status once on mount…
  useEffect(() => {
    let off = false
    getRefreshStatus().then((s) => { if (!off) setJob(s) })
    return () => { off = true }
  }, [])

  const running = job?.status === 'running'

  // …then keep polling ONLY while a refresh is actually running (stops on done/error).
  useEffect(() => {
    if (!running) return
    let off = false
    const id = setInterval(async () => { const s = await getRefreshStatus(); if (!off) setJob(s) }, 4000)
    return () => { off = true; clearInterval(id) }
  }, [running])
  const jobName = (code?: string) => insurers.find((i) => i.code === code)?.name ?? code ?? ''

  const refresh = async (code: string) => {
    setNote('')
    const r = await triggerUlipRefresh(code, month)
    if (r.busy) setNote('Another refresh is already running — let it finish first.')
    else if (!r.ok) setNote(r.error ?? 'Could not start the refresh.')
    else { getRefreshStatus().then(setJob) }
  }

  return (
    <div>
      {/* live refresh status */}
      {job && (
        <div className={`mb-3 rounded-xl border px-4 py-2.5 text-[12.5px] ${running ? 'border-[#7a5cff]/30 bg-accent-soft text-[#5b43c9]' : job.status === 'error' ? 'border-down/30 bg-down-soft text-down' : 'border-up/30 bg-up-soft text-up'}`}>
          {running
            ? <span className="inline-flex items-center gap-2"><RefreshCw size={13} className="animate-spin" /> Fetching <b>{jobName(job.insurer)}</b> ({job.month}) — downloading + AI extraction in progress…</span>
            : <span>Last refresh: <b>{jobName(job.insurer)}</b> ({job.month}) — {job.message ?? job.status}. <span className="text-faint">Reload to see updated funds.</span></span>}
        </div>
      )}
      {note && <div className="mb-3 text-[12px] text-[#c4762a]">{note}</div>}

      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Per-insurer freshness</div>
        <span className="text-[10.5px] italic text-faint">“Fetch new data” re-downloads + re-extracts (uses Gemini; ~1-3 min)</span>
      </div>
      <div className="mt-2 divide-y divide-[#f0f1f4] rounded-2xl border border-line bg-surface">
        {insurers.map((i) => (
          <div key={i.code} className="flex flex-wrap items-center gap-2 px-4 py-3">
            <span className="w-52 shrink-0 text-[13px] font-medium text-strong">{i.name} <span className="font-mono text-[10px] text-faint">{i.code}</span></span>
            {i.status === 'parked' && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-bold uppercase text-[#9a8c63]">Parked</span>}
            {i.status === 'active' && i.months.length === 0 && <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-bold uppercase text-muted">Pending</span>}
            {i.months.map((m) => {
              const mm = Number(m.month.split('-')[1])
              const label = `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm] ?? m.month} ${m.month.split('-')[0]}`
              return (
                <span key={m.month} className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${m.funds > 0 ? 'bg-up-soft text-up' : 'bg-warn-soft text-[#b08a2e]'}`}>
                  {label} · {m.funds > 0 ? `${m.funds} fund${m.funds === 1 ? '' : 's'} ✓` : 'archived'}{m.failed > 0 ? ` · ${m.failed} quarantined ⚠` : ''}
                </span>
              )
            })}
            {i.status === 'active' && (
              <button onClick={() => refresh(i.code)} disabled={running}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-muted transition-colors hover:border-[#7a5cff] hover:text-[#7a5cff] disabled:opacity-40">
                <RefreshCw size={11} className={running && job?.insurer === i.code ? 'animate-spin' : ''} /> Fetch new data
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Quarantine / review queue ({month})</div>
      <div className="mt-2">
        {quarantine.length === 0 && <p className="text-[12px] italic text-faint">No quarantined funds — all stored funds passed validation.</p>}
        {quarantine.map((q) => (
          <div key={q.sfin} className="border-b border-line py-2.5 last:border-0">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-strong">{q.name} <span className="font-mono text-[10px] text-faint">{q.sfin}</span></span>
              <span className="font-mono text-[11px] text-down">conf {q.confidence ?? 0}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {q.flags.map((fl, idx) => (
                <span key={idx} className={`rounded px-1.5 py-0.5 text-[10px] ${fl.severity === 'reject' ? 'bg-down-soft text-down' : 'bg-warn-soft text-[#c4762a]'}`}>{fl.code}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ——————————————————————————————— AI chat tab ———————————————————————————————
function ChatTab({ month }: { month: string }) {
  const [messages, setMessages] = useState<UlipChatMsg[]>([])
  const [input, setInput] = useState('')
  const [webDive, setWebDive] = useState(true) // web-dive ON by default; user can toggle off
  const [loading, setLoading] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, loading])

  const send = async (text?: string) => {
    const q = (text ?? input).trim()
    if (!q || loading) return
    const next: UlipChatMsg[] = [...messages, { role: 'user', content: q }]
    setMessages(next); setInput(''); setSources([]); setLoading(true)
    const res = await fetchUlipChat(next, { month, webDive })
    setLoading(false)
    if (res) { setMessages([...next, { role: 'assistant', content: res.answer }]); setSources(res.grounded ?? []) }
    else setMessages([...next, { role: 'assistant', content: 'The AI desk is unreachable right now — please try again in a moment.' }])
  }

  const suggestions = [
    'Which funds have the highest 1-year return?',
    'Which funds hold Reliance Industries, and at what weight?',
    'Compare the equity allocation of HDFC vs SBI large-cap funds',
    'Summarise the sector exposure across all insurers',
  ]

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles size={15} className="text-[#7a5cff]" />
        <span className="text-[13px] font-bold text-ink">Insurance Monitor AI</span>
        <span className="text-[11px] text-faint">grounded in the {month} factsheet data</span>
        <button
          onClick={() => setWebDive((v) => !v)}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${webDive ? 'border-[#7a5cff] bg-accent-soft text-[#7a5cff]' : 'border-line bg-surface text-muted hover:border-line'}`}
          title="Also search the live web for context the factsheets don't carry"
        >
          <Globe size={12} /> Web dive {webDive ? 'ON' : 'OFF'}
        </button>
      </div>

      <div ref={scrollRef} className="max-h-[460px] min-h-[260px] space-y-4 overflow-auto px-4 py-4">
        {messages.length === 0 && (
          <div>
            <p className="text-[13px] text-muted">Ask anything about the ULIP funds — NAVs, returns, holdings, allocations, cross-insurer exposure. Want a pick or a direct view? Just ask.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-[#7a5cff] hover:text-[#7a5cff]">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${m.role === 'user' ? 'whitespace-pre-wrap bg-inkfill text-white' : 'border border-line bg-surface text-strong'}`}>
              {m.role === 'assistant' ? <MarkdownLite text={m.content} /> : m.content}
            </div>
          </div>
        ))}
        {loading && <div className="flex justify-start"><div className="rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[13px] italic text-faint">{webDive ? 'Searching factsheets + web…' : 'Reading the factsheets…'}</div></div>}
        {sources.length > 0 && !loading && (
          <div className="text-[10.5px] text-faint">Grounded in: {sources.join(' · ')}</div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send() }}
          placeholder="Ask about the ULIP funds…"
          className="flex-1 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-strong outline-none focus:border-[#7a5cff]"
        />
        <button
          onClick={() => send()}
          disabled={loading || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-inkfill px-4 py-2.5 text-[13px] font-bold text-white transition-opacity disabled:opacity-40"
        >
          <Send size={13} /> Ask
        </button>
      </div>
      <p className="px-4 pb-3 text-[10.5px] italic text-faint">Synthesis of public factsheet data.</p>
    </div>
  )
}

// ——————————————————————————————— Trends tab ———————————————————————————————
const TREND_COLORS = ['#2186c4', '#7a5cff', '#1d9d6f', '#e0922f', '#c43a3a']
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-')
  return `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)] ?? m} '${y.slice(2)}`
}

function TrendChart({ title, data, lines, fmt }: {
  title: string
  data: Record<string, number | string | null>[]
  lines: { key: string; name: string; color: string }[]
  fmt?: (v: number) => string
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">{title}</div>
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f0f1f4" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10.5, fill: '#9ca1aa' }} tickLine={false} axisLine={{ stroke: '#ececf0' }} />
          <YAxis tick={{ fontSize: 10.5, fill: '#9ca1aa' }} tickLine={false} axisLine={false} width={46}
            domain={['auto', 'auto']} tickFormatter={fmt ? (v) => fmt(Number(v)) : undefined} />
          <Tooltip
            contentStyle={{ borderRadius: 12, border: '1px solid #ececf0', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
            formatter={(v) => (v == null ? '—' : fmt ? fmt(Number(v)) : v)}
          />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />}
          {lines.map((l) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={1.8} dot={{ r: 2 }} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

const GAIN = '#1d9d6f'
const LOSS = '#c43a3a'

// Month-over-month asset drift (Trends tab only) needs a STABLE set of buckets so the
// same row lines up across months — this is the one place light grouping is justified.
// (The per-fund detail panel shows verbatim labels with no bucketing.)
const ASSET_ORDER = ['Equity', 'Corporate Bonds / Debentures', 'Govt Securities', 'Deposits', 'Money Market / Cash', 'Net Current Assets', 'Debt', 'Other']
function assetBucket(label: string): string {
  const t = label.toLowerCase()
  if (/equit/.test(t)) return 'Equity'
  if (/corp|deben|bond/.test(t)) return 'Corporate Bonds / Debentures'
  if (/g-?sec|gsec|govt|government/.test(t)) return 'Govt Securities'
  if (/deposit/.test(t)) return 'Deposits'
  if (/money market|mmi|cash|treps|repo|liquid/.test(t)) return 'Money Market / Cash'
  if (/net current|\bnca\b/.test(t)) return 'Net Current Assets'
  if (/debt/.test(t)) return 'Debt'
  return 'Other'
}

// Factsheet portfolio tables interleave real securities with aggregate/subtotal rows
// (Equity, Others, MMI, NCA, Cash, G-Sec, Total…). These are NOT holdings — diffing them
// as if they were produces nonsense ("Increased: Others +1.49pp"), so they're excluded
// from the month-over-month buy/sell/resize computation.
const AGG_ROW = /^(others?|mmi|nca|equity|debt|cash( ?(&|and) ?(cash equivalents?|others?))?|net current assets?|money market( instruments?)?|g-?\s?sec|govt\.? securities|government securities|total|grand total|treps|tri-?party repo|reverse repo|current assets|sub-?total)$/i
function isRealSecurity(name: string): boolean {
  return name != null && name.trim() !== '' && !AGG_ROW.test(name.trim())
}

// Sum factsheet asset labels into canonical buckets (Equity / Debt / MMI / …).
function bucketAssets(allocs: { label: string; weight: number | null }[]) {
  const m = new Map<string, number>()
  for (const a of allocs) { const b = assetBucket(a.label); m.set(b, (m.get(b) ?? 0) + (a.weight ?? 0)) }
  return m
}

// Signed percentage-point delta chip (▲ +1.20pp / ▼ -0.80pp).
function DeltaPill({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[12px] text-faint">—</span>
  const up = value >= 0
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-[12px] font-bold" style={{ color: up ? GAIN : LOSS }}>
      {up ? '▲' : '▼'} {up ? '+' : ''}{value.toFixed(2)}pp
    </span>
  )
}

// ——— One consecutive-month transition (prev → curr): every aspect diffed on its own. ———
// Reliability rule: a dimension is only diffed when BOTH months actually disclose it.
// If a month omits holdings / allocations we say so, rather than inventing a full "churn"
// (a naive diff would otherwise report "30 holdings entered" the first month data appears).
function computeStep(prev: HistoryPoint, curr: HistoryPoint) {
  const navD = prev.nav != null && curr.nav != null ? curr.nav - prev.nav : null
  const aumD = prev.aumTotalCr != null && curr.aumTotalCr != null ? curr.aumTotalCr - prev.aumTotalCr : null

  const assetsBoth = prev.assetAlloc.length > 0 && curr.assetAlloc.length > 0
  const pBuck = bucketAssets(prev.assetAlloc)
  const cBuck = bucketAssets(curr.assetAlloc)
  const assetRows = !assetsBoth ? [] : ASSET_ORDER
    .filter((k) => pBuck.has(k) || cBuck.has(k))
    .map((k) => ({ k, s: pBuck.get(k) ?? 0, e: cBuck.get(k) ?? 0, d: (cBuck.get(k) ?? 0) - (pBuck.get(k) ?? 0) }))
    .filter((r) => Math.abs(r.d) >= 0.05)

  const sectorsBoth = prev.sectorAlloc.length > 0 && curr.sectorAlloc.length > 0
  const secS = new Map(prev.sectorAlloc.map((x) => [x.label, x.weight ?? 0]))
  const secE = new Map(curr.sectorAlloc.map((x) => [x.label, x.weight ?? 0]))
  // Only sectors present in BOTH months — a sector "move" means weight drift of a continuing
  // sector, not an appear/disappear. This also filters out factsheets whose multi-line NIC
  // sector names got line-split on extraction (they'd otherwise show as huge phantom ±moves).
  const sectorRows = !sectorsBoth ? [] : [...secE.keys()].filter((l) => secS.has(l))
    .map((l) => ({ l, d: secE.get(l)! - secS.get(l)! }))
    .filter((r) => Math.abs(r.d) >= 0.05)
    .sort((m, n) => Math.abs(n.d) - Math.abs(m.d))
    .slice(0, 10)

  const periods = orderPeriods([...new Set([...prev.returns, ...curr.returns].map((r) => r.period))])
  const retRows = periods
    .map((p) => {
      const s = prev.returns.find((r) => r.period === p)?.returnPct ?? null
      const e = curr.returns.find((r) => r.period === p)?.returnPct ?? null
      return { p, s, e, d: s != null && e != null ? e - s : null }
    })
    .filter((r) => r.d != null && Math.abs(r.d) >= 0.05)

  // Only real securities — drop aggregate/subtotal rows so the buy/sell list is meaningful.
  const prevSec = prev.holdings.filter((h) => isRealSecurity(h.security))
  const currSec = curr.holdings.filter((h) => isRealSecurity(h.security))
  const holdingsBoth = prevSec.length > 0 && currSec.length > 0
  const hS = new Map(prevSec.map((h) => [h.security, h.weightPct ?? 0]))
  const hE = new Map(currSec.map((h) => [h.security, h.weightPct ?? 0]))
  const entered = !holdingsBoth ? [] : currSec.filter((h) => !hS.has(h.security))
  const exited = !holdingsBoth ? [] : prevSec.filter((h) => !hE.has(h.security))
  const both = !holdingsBoth ? [] : [...hE.keys()].filter((k) => hS.has(k)).map((k) => ({ security: k, d: hE.get(k)! - hS.get(k)! }))
  const increased = both.filter((c) => c.d > 0.1).sort((m, n) => n.d - m.d)
  const trimmed = both.filter((c) => c.d < -0.1).sort((m, n) => m.d - n.d)

  const hasAnyChange =
    (navD != null && navD !== 0) || (aumD != null && aumD !== 0) ||
    assetRows.length > 0 || sectorRows.length > 0 || retRows.length > 0 ||
    entered.length + exited.length + increased.length + trimmed.length > 0

  return { navD, aumD, assetsBoth, sectorsBoth, holdingsBoth, prevSecCount: prevSec.length, currSecCount: currSec.length, assetRows, sectorRows, retRows, entered, exited, increased, trimmed, hasAnyChange }
}

// Compact prev → curr metric tile (current value + signed % change + prior value).
function StepValue({ label, prev, curr, fmt }: { label: string; prev: number | null; curr: number | null; fmt: (n: number) => string }) {
  const d = prev != null && curr != null ? curr - prev : null
  const rel = prev != null && prev !== 0 && curr != null ? ((curr - prev) / Math.abs(prev)) * 100 : null
  const up = (d ?? 0) >= 0
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="font-mono text-[15px] font-bold text-ink">{curr != null ? fmt(curr) : '—'}</span>
        {rel != null && d !== 0 && <span className="font-mono text-[11.5px] font-bold" style={{ color: up ? GAIN : LOSS }}>{up ? '▲ +' : '▼ '}{rel.toFixed(2)}%</span>}
      </div>
      <div className="text-[10.5px] text-faint">from {prev != null ? fmt(prev) : '—'}{d != null && d !== 0 ? ` · ${up ? '+' : ''}${fmt(d)}` : ''}</div>
    </div>
  )
}

function ActivityCol({ title, color, items, empty }: {
  title: string; color: string; empty: string
  items: { k: string; right: string; color: string }[]
}) {
  return (
    <div>
      <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color }}>{title} ({items.length})</div>
      <div className="mt-1.5 space-y-1">
        {items.length === 0 && <div className="text-[12px] italic text-faint">{empty}</div>}
        {items.map((it) => (
          <div key={it.k} className="flex items-center justify-between gap-2 text-[12px]"><span className="truncate text-muted">{it.k}</span><span className="shrink-0 font-mono" style={{ color: it.color }}>{it.right}</span></div>
        ))}
      </div>
    </div>
  )
}

// One month-over-month step: NAV/AUM, returns, asset & sector mix, holdings — each its own block.
function MonthStepCard({ prev, curr }: { prev: HistoryPoint; curr: HistoryPoint }) {
  const s = computeStep(prev, curr)
  const holdingsNote = !s.holdingsBoth
    ? `Holdings not disclosed in ${s.prevSecCount === 0 ? monthLabel(prev.month) : monthLabel(curr.month)} — buys / sells can't be computed for this step.`
    : null
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      {/* step header */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-inkfill px-2.5 py-1 text-[12px] font-bold text-white">{monthLabel(prev.month)} → {monthLabel(curr.month)}</span>
        {!s.hasAnyChange && <span className="text-[11.5px] italic text-faint">No material change this month.</span>}
      </div>

      {/* headline metrics */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StepValue label="NAV" prev={prev.nav} curr={curr.nav} fmt={(v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })} />
        <StepValue label="AUM (₹ Cr)" prev={prev.aumTotalCr} curr={curr.aumTotalCr} fmt={(v) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
        <div className="rounded-xl border border-line bg-surface px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint">Holdings in / out</div>
          <div className="mt-0.5 font-mono text-[15px] font-bold text-ink">{s.holdingsBoth ? `${s.entered.length} / ${s.exited.length}` : '—'}</div>
          <div className="text-[10.5px] text-faint">{s.holdingsBoth ? 'bought / sold' : 'not disclosed'}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint">Resized</div>
          <div className="mt-0.5 font-mono text-[15px] font-bold text-ink">{s.holdingsBoth ? `${s.increased.length} / ${s.trimmed.length}` : '—'}</div>
          <div className="text-[10.5px] text-faint">{s.holdingsBoth ? 'up / down' : 'not disclosed'}</div>
        </div>
      </div>

      {/* returns moved + asset mix shifted */}
      {(s.retRows.length > 0 || s.assetRows.length > 0) && (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {s.retRows.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-faint">Returns moved</div>
              <div className="flex flex-wrap gap-1.5">
                {s.retRows.map((r) => (
                  <span key={r.p} className="inline-flex items-center gap-1.5 rounded-lg bg-panel px-2 py-1 text-[11.5px] text-muted"><b className="text-muted">{r.p}</b> {pct(r.s)}→{pct(r.e)} <DeltaPill value={r.d} /></span>
                ))}
              </div>
            </div>
          )}
          {s.assetRows.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-faint">Asset mix shifted</div>
              <div className="space-y-1">
                {s.assetRows.map((a) => (
                  <div key={a.k} className="flex items-center gap-2 text-[12px]">
                    <span className="w-44 shrink-0 truncate text-muted">{a.k}</span>
                    <span className="w-12 text-right font-mono text-faint">{pct(a.s)}</span>
                    <span className="text-faint">→</span>
                    <span className="w-12 text-right font-mono text-strong">{pct(a.e)}</span>
                    <span className="ml-auto"><DeltaPill value={a.d} /></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* holdings activity */}
      <div className="mt-3">
        <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-faint">Holdings activity</div>
        {holdingsNote ? <p className="text-[12px] italic text-faint">{holdingsNote}</p>
          : s.entered.length + s.exited.length + s.increased.length + s.trimmed.length === 0
            ? <p className="text-[12px] italic text-faint">No holdings bought, sold or resized this month.</p>
            : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <ActivityCol title="Bought (new)" color={GAIN} empty="none" items={s.entered.slice(0, 10).map((h) => ({ k: h.security, right: pct(h.weightPct), color: GAIN }))} />
                <ActivityCol title="Sold (exited)" color={LOSS} empty="none" items={s.exited.slice(0, 10).map((h) => ({ k: h.security, right: pct(h.weightPct), color: LOSS }))} />
                <ActivityCol title="Increased" color={GAIN} empty="none" items={s.increased.slice(0, 10).map((c) => ({ k: c.security, right: `+${c.d.toFixed(2)}pp`, color: GAIN }))} />
                <ActivityCol title="Trimmed" color={LOSS} empty="none" items={s.trimmed.slice(0, 10).map((c) => ({ k: c.security, right: `${c.d.toFixed(2)}pp`, color: LOSS }))} />
              </div>
            )}
        {s.holdingsBoth && (s.entered.length > 0 || s.exited.length > 0) && (
          <p className="mt-2 text-[10.5px] italic text-faint">Based on the factsheet's disclosed top holdings — a name slipping below the disclosure cut-off can read as “sold”.</p>
        )}
        {s.sectorRows.length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-faint">Sector moves</div>
            <div className="flex flex-wrap gap-2">
              {s.sectorRows.map((x) => (
                <span key={x.l} className="inline-flex items-center gap-1.5 rounded-lg bg-panel px-2 py-1 text-[11.5px] text-muted">{x.l} <DeltaPill value={x.d} /></span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TrendsBody({ history, fromMonth, toMonth }: { history: FundHistory; fromMonth: string; toMonth: string }) {
  const pts = history.points
  // Resolve the chosen endpoints (order-independent: swap if From is after To).
  let a = pts.findIndex((p) => p.month === fromMonth)
  let b = pts.findIndex((p) => p.month === toMonth)
  if (a < 0) a = 0
  if (b < 0) b = pts.length - 1
  if (a > b) { const t = a; a = b; b = t }
  const win = pts.slice(a, b + 1)
  const latest = win[win.length - 1]

  // Consecutive-month steps within the window — newest first, so the most recent change is on top.
  const steps: { prev: HistoryPoint; curr: HistoryPoint }[] = []
  for (let i = 1; i < win.length; i++) steps.push({ prev: win[i - 1], curr: win[i] })
  steps.reverse()

  // ——— supporting full-series charts (over the selected window) ———
  const navData = win.map((p) => ({ month: monthLabel(p.month), nav: p.nav }))
  const aumData = win.map((p) => ({ month: monthLabel(p.month), aum: p.aumTotalCr }))
  const tenors = ['1Y', '3Y', '5Y'].filter((t) => win.some((p) => p.returns.some((r) => r.period === t)))
  const retData = win.map((p) => { const row: Record<string, number | string | null> = { month: monthLabel(p.month) }; for (const t of tenors) row[t] = p.returns.find((r) => r.period === t)?.returnPct ?? null; return row })
  const top5 = latest.holdings.slice(0, 5).map((h) => h.security)
  const driftData = win.map((p) => { const row: Record<string, number | string | null> = { month: monthLabel(p.month) }; for (const name of top5) row[name] = p.holdings.find((h) => h.security === name)?.weightPct ?? null; return row })

  return (
    <div className="space-y-5">
      {/* caption (the From→To selectors live in the controls row above) */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
        <span className="font-bold uppercase tracking-[0.12em]">Month by month</span>
        <span>{monthLabel(win[0].month)} → {monthLabel(latest.month)} · {steps.length} step{steps.length === 1 ? '' : 's'} · newest first</span>
      </div>

      {/* per-month timeline */}
      {steps.length === 0
        ? <p className="rounded-xl bg-panel p-4 text-[12.5px] italic text-faint">Only one month in this window — widen the From / To range to see month-over-month changes.</p>
        : <div className="space-y-4">{steps.map((st) => <MonthStepCard key={st.curr.month} prev={st.prev} curr={st.curr} />)}</div>}

      {/* supporting full-series charts */}
      <div>
        <div className="mb-2 mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Full series · {win.length} months</div>
        <div className="grid gap-4 lg:grid-cols-2">
          <TrendChart title="NAV trend" data={navData} lines={[{ key: 'nav', name: 'NAV', color: TREND_COLORS[0] }]} fmt={(v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })} />
          <TrendChart title="AUM trend (₹ Cr)" data={aumData} lines={[{ key: 'aum', name: 'AUM (Cr)', color: TREND_COLORS[2] }]} fmt={(v) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
        </div>
        {tenors.length > 0 && <div className="mt-4"><TrendChart title="Returns evolution (%)" data={retData} lines={tenors.map((t, i) => ({ key: t, name: t, color: TREND_COLORS[i % TREND_COLORS.length] }))} fmt={(v) => `${v.toFixed(1)}%`} /></div>}
        {top5.length > 0 && <div className="mt-4"><TrendChart title="Top-holding weight trajectory (%)" data={driftData} lines={top5.map((name, i) => ({ key: name, name: name.length > 16 ? name.slice(0, 15) + '…' : name, color: TREND_COLORS[i % TREND_COLORS.length] }))} fmt={(v) => `${v.toFixed(1)}%`} /></div>}
      </div>
    </div>
  )
}

function TrendsTab({ month, insurers }: {
  month: string
  insurers: { code: string; name: string; status: string; latestStored: string | null; latestWithData: string | null }[]
}) {
  // Same browsing UX as the Funds tab (shared FundBrowser), but the right panel is the
  // month-over-month "what changed" view instead of the snapshot.
  const active = useMemo(() => insurers.filter((i) => i.status === 'active'), [insurers])
  const [bank, setBank] = useState<string | null>(null)
  // The global as-of month picker is hidden on Trends, so the left fund list follows the
  // selected insurer's OWN latest stored month (insurers' latest months differ — e.g. Kotak
  // ends in May while others run to Jun). Without this, an insurer behind the global latest
  // month would show an empty fund list.
  const bankLatest = (bank ? active.find((i) => i.code === bank)?.latestWithData : null) ?? month
  const { funds: allFunds, loading } = useUlipFunds(null, bankLatest, null)
  const browser = useFundBrowser({ insurers, allFunds, bank, setBank, month: bankLatest })
  const { sfin } = browser
  const { history, loading: histLoading } = useFundHistory(sfin)

  // Free choice of BOTH endpoints — any "from" month vs any "to" month the fund has.
  const histMonths = history?.points.map((p) => p.month) ?? []
  const [fromMonth, setFromMonth] = useState<string | null>(null)
  const [toMonth, setToMonth] = useState<string | null>(null)
  // Default the range to the full span whenever the fund's history (re)loads.
  useEffect(() => {
    const m = history?.points.map((p) => p.month) ?? []
    setFromMonth(m[0] ?? null)
    setToMonth(m[m.length - 1] ?? null)
  }, [history?.sfin, history?.points.length])

  const picked = browser.filtered.find((f) => f.sfin === sfin) ?? allFunds.find((f) => f.sfin === sfin)

  return (
    <div>
      <FundControls
        insurers={insurers}
        active={active}
        bank={bank}
        setBank={setBank}
        browser={browser}
        extra={histMonths.length > 1 ? (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-faint">From month</span>
              <select value={fromMonth ?? ''} onChange={(e) => setFromMonth(e.target.value)} className={browserSelectCls}>
                {histMonths.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            <span className="pb-2.5 text-faint">→</span>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-faint">To month</span>
              <select value={toMonth ?? ''} onChange={(e) => setToMonth(e.target.value)} className={browserSelectCls}>
                {histMonths.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          </div>
        ) : undefined}
      />

      <div className="mt-2 text-[11px] text-faint">
        {browser.searching
          ? `${browser.filtered.length} match${browser.filtered.length === 1 ? '' : 'es'} across all insurers for “${browser.query}”`
          : `${browser.filtered.length} funds · ${insurerShortName(insurers, bank)}${browser.category ? ` · ${browser.category}` : ''} — month-over-month changes`}
      </div>

      <div className="mt-3 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
        <FundList insurers={insurers} browser={browser} loading={loading} maxH="max-h-[620px]" />

        {/* month-over-month "what changed" panel */}
        <div>
          {picked && (
            <div className="mb-3">
              <h3 className="text-[16px] font-medium text-ink">{picked.name}</h3>
              <p className="mt-0.5 font-mono text-[11px] text-faint">{insurerShortName(insurers, picked.insurer)} · {picked.sfin}</p>
            </div>
          )}
          {(histLoading || loading) && <p className="text-[13px] italic text-faint">Loading…</p>}
          {!histLoading && history && history.points.length > 1 && fromMonth && toMonth && <TrendsBody key={history.sfin} history={history} fromMonth={fromMonth} toMonth={toMonth} />}
          {!histLoading && history && history.points.length === 1 && <p className="rounded-xl bg-panel p-4 text-[12.5px] italic text-faint">Only one stored month ({monthLabel(history.points[0].month)}) for this fund yet — month-over-month changes appear once a second month is captured.</p>}
          {!histLoading && history && history.points.length === 0 && <p className="text-[13px] italic text-faint">No stored months for this fund yet.</p>}
          {!histLoading && !history && sfin && <p className="text-[13px] italic text-faint">History unavailable for this fund.</p>}
          {!sfin && !loading && <p className="text-[13px] italic text-faint">Pick a fund to see what changed month over month.</p>}
        </div>
      </div>
    </div>
  )
}

// ——————————————————————————————— Explorer shell ———————————————————————————————
type Tab = 'funds' | 'trends' | 'compare' | 'consolidated' | 'qa' | 'chat' | 'manage'

export function UlipExplorer() {
  const { data, loading } = useUlipInsurers()
  const [tab, setTab] = useState<Tab>('funds')
  const [month, setMonth] = useState<string | null>(null)
  // Admin-only tools (factsheet upload / re-extract). Non-admins get {admin:false} and
  // never see the tab; the server enforces the same check on every one of those routes.
  const { status: admin } = useUlipAdmin()

  useEffect(() => {
    // Default to the latest BROADLY-covered month (defaultMonth), not the sparse newest
    // one — so the picker doesn't open on a month only 1 insurer has posted.
    if (data && !month) setMonth(data.defaultMonth ?? data.latestMonth ?? data.months[0] ?? null)
  }, [data, month])

  if (loading) return <p className="text-[13px] italic text-faint">Loading ULIP coverage…</p>
  if (!data || !month) return <p className="text-[13px] italic text-faint">ULIP data unavailable. Start the server and run the ULIP pipeline (npm run ulip).</p>

  const insurerOpts = data.insurers.map((i) => ({
    code: i.code, name: i.name, status: i.status, latestStored: i.latestStored,
    // latestStored counts *attempted* months (incl. failed parses with 0 funds), so for the
    // Trends fund list we use the latest month that actually has stored funds.
    latestWithData: i.months.filter((m) => m.funds > 0).map((m) => m.month).sort().pop() ?? null,
  }))

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <TabButton active={tab === 'funds'} onClick={() => setTab('funds')}><span className="flex items-center gap-1.5"><Table2 size={13} /> Funds</span></TabButton>
          <TabButton active={tab === 'trends'} onClick={() => setTab('trends')}><span className="flex items-center gap-1.5"><TrendingUp size={13} /> Trends</span></TabButton>
          <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}><span className="flex items-center gap-1.5"><Sparkles size={13} /> Ask AI</span></TabButton>
          <TabButton active={tab === 'consolidated'} onClick={() => setTab('consolidated')}><span className="flex items-center gap-1.5"><Layers size={13} /> Consolidated</span></TabButton>
          <TabButton active={tab === 'compare'} onClick={() => setTab('compare')}><span className="flex items-center gap-1.5"><GitCompareArrows size={13} /> Compare</span></TabButton>
          <TabButton active={tab === 'qa'} onClick={() => setTab('qa')}><span className="flex items-center gap-1.5"><ShieldCheck size={13} /> Freshness / QA</span></TabButton>
          {admin?.admin && (
            <TabButton active={tab === 'manage'} onClick={() => setTab('manage')}><span className="flex items-center gap-1.5"><Upload size={13} /> Manage data</span></TabButton>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DataSourceBadge variant="live" label="Postgres" />
          {/* Trends has its own From→To range selectors, so the single as-of month picker is hidden there to avoid a clashing, redundant control. */}
          {tab !== 'trends' && (
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-strong">
              {data.months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="mt-5">
        {tab === 'funds' && <FundsTab month={month} insurers={insurerOpts} />}
        {tab === 'trends' && <TrendsTab month={month} insurers={insurerOpts} />}
        {tab === 'consolidated' && <ConsolidatedTab month={month} />}
        {tab === 'qa' && <QaTab month={month} insurers={data.insurers} />}
        {tab === 'manage' && admin?.admin && (
          <FactsheetUpload status={admin} onIngested={() => window.location.reload()} />
        )}
        {/* Chat & Compare stay mounted (hidden) so their state — chat history and picked
            funds — survives tab switches instead of being destroyed. */}
        <div hidden={tab !== 'chat'}><ChatTab month={month} /></div>
        <div hidden={tab !== 'compare'}><CompareTab month={month} /></div>
      </div>

      <AsOf month={month} />
    </div>
  )
}

export type { UlipFund }
