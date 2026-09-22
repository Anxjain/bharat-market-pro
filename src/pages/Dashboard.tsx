// The Terminal — landing screen modelled on a pro trading workstation:
// instrument toolbar, candlestick chart, right rail with watchlist / alerts / instrument card.
// Every control is live: SMA & volume toggles, range picker, accordions, alert switches.

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Bell, BellOff, Sparkle } from 'lucide-react'
import { indices } from '../data/market'
import { deriveCandles } from '../data/series'
import { companies, companyBySymbol } from '../data/companies'
import { useWatchlist } from '../lib/watchlist'
import { useToast } from '../lib/toast'
import { useCandles, useQuotes, useUniverse, useAlerts, useFilings, togglePriceAlert } from '../lib/api'
import { UP, DOWN } from '../components/CandleChart'
import { TradingChart } from '../components/TradingChart'
import { CompanyLogo } from '../components/Logo'
import { DataSourceBadge } from '../components/DataSourceBadge'
import { Disclaimer } from '../components/ui'

const ALL_INDEX_NAMES = indices.map((i) => i.name)

const INDEX_META: Record<string, { short: string; color: string; dbName: string | null }> = {
  'NIFTY 50': { short: 'N50', color: '#16181d', dbName: 'Nifty 50' },
  SENSEX: { short: 'BSE', color: '#0ea5e9', dbName: null }, // BSE index — not in NSE archive; stays mock
  'NIFTY BANK': { short: 'NB', color: '#a855f7', dbName: 'Nifty Bank' },
  'NIFTY FIN SERVICE': { short: 'NFS', color: '#f59e0b', dbName: 'Nifty Financial Services' },
  'NIFTY IT': { short: 'NIT', color: '#6366f1', dbName: 'Nifty IT' },
  'INDIA VIX': { short: 'VIX', color: '#ef4444', dbName: 'India VIX' },
}

const RANGES = [
  { label: '1M', bars: 22 },
  { label: '2M', bars: 44 },
  { label: '3M', bars: 90 },
]

/** Live system status lines derived from /api/status — real, not hardcoded. */
function useSystemStatus() {
  const [items, setItems] = useState<{ id: string; text: string; meta: string }[]>([])
  useEffect(() => {
    let off = false
    fetch('/api/status', { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (off || !s) return
        setItems([
          { id: 's1', text: 'NSE EOD price store', meta: `${s.priceStore.instruments} instruments · ${s.priceStore.prices.toLocaleString('en-IN')} rows · synced ${s.priceStore.lastIngest ? new Date(s.priceStore.lastIngest).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}` },
          { id: 's2', text: 'Live news + exchange wire', meta: '7 press desks · 5 NSE disclosure feeds · 5-min refresh' },
          { id: 's3', text: 'AI engine', meta: s.llm?.available ? `online · ${s.llm.model}` : 'offline — key not configured' },
        ])
      })
      .catch(() => { if (!off) setItems([{ id: 's0', text: 'API server unreachable', meta: 'start server/ with npm run dev' }]) })
    return () => { off = true }
  }, [])
  return items
}

function IndexBadge({ name, size = 24 }: { name: string; size?: number }) {
  const meta = INDEX_META[name]
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: meta.color, fontSize: size * 0.34 }}
    >
      {meta.short}
    </span>
  )
}

function pctOver(closes: number[], bars: number): number {
  if (closes.length < bars + 1) return 0
  const a = closes[closes.length - 1 - bars]
  const b = closes[closes.length - 1]
  return ((b - a) / a) * 100
}

export function Dashboard() {
  const navigate = useNavigate()
  const { symbols } = useWatchlist()
  const [idx, setIdx] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [range, setRange] = useState(RANGES[2])
  const [briefOpen, setBriefOpen] = useState(false)
  const [alertTab, setAlertTab] = useState<'Alerts' | 'History' | 'System'>('Alerts')
  const [openSection, setOpenSection] = useState<string | null>(null)
  const { active: alerts, history: alertHistory, refresh: refreshAlerts } = useAlerts()
  const systemItems = useSystemStatus()
  const { toast } = useToast()

  const instrument = indices[idx]
  const mockCandles = useMemo(() => deriveCandles(instrument.name, instrument.history), [instrument])
  const dbName = INDEX_META[instrument.name].dbName
  const { candles: allCandles, source: priceSource } = useCandles('index', dbName ?? '', mockCandles)
  const candles = useMemo(() => allCandles.slice(-range.bars), [allCandles, range])

  // Real delayed quotes for every tracked index (one batch call)
  const indexQuotes = useQuotes(ALL_INDEX_NAMES)
  const lastClose = allCandles[allCandles.length - 1]?.c
  const prevClose = allCandles[allCandles.length - 2]?.c
  const iq = indexQuotes.get(instrument.name)
  // Display priority: delayed quote → real EOD close → mock illustration
  const dispSource: 'delayed' | 'live' | 'sample' = iq ? 'delayed' : priceSource === 'live' ? 'live' : 'sample'
  const dispValue = iq?.price ?? (priceSource === 'live' && lastClose ? lastClose : instrument.value)
  const dispChange =
    iq?.changePct ??
    (priceSource === 'live' && lastClose && prevClose ? ((lastClose - prevClose) / prevClose) * 100 : instrument.changePct)
  const up = dispChange >= 0
  const closes = allCandles.map((c) => c.c)
  // 3M ≈ 63 trading sessions. If the loaded window is shorter, fall back to the whole
  // span and label it honestly (e.g. "48d") rather than mislabelling it "3M".
  const has3M = closes.length >= 64
  const perf = [
    { label: '1W', v: pctOver(closes, 5) },
    { label: '1M', v: pctOver(closes, 21) },
    { label: has3M ? '3M' : `${Math.max(closes.length - 1, 0)}d`, v: has3M ? pctOver(closes, 63) : pctOver(closes, closes.length - 1) },
  ]

  // Resolve watchlist symbols against curated set OR the NIFTY 500 universe
  const { rows: universe } = useUniverse()
  const watch = symbols
    .map((s) => {
      const c = companyBySymbol.get(s)
      if (c) return { symbol: c.symbol, sector: c.sector, domain: c.domain as string | undefined, price: c.price, dayChangePct: c.dayChangePct }
      const u = universe.find((r) => r.symbol === s)
      if (u) return { symbol: u.symbol, sector: u.industry, domain: undefined, price: u.close ?? 0, dayChangePct: u.changePct ?? 0 }
      return null
    })
    .filter((c): c is { symbol: string; sector: string; domain: string | undefined; price: number; dayChangePct: number } => c !== null)
  const watchQuotes = useQuotes(watch.slice(0, 6).map((c) => c.symbol))

  // Real per-industry performance from the universe (group by industry, avg day change)
  const topSectors = useMemo(() => {
    const byInd = new Map<string, { sum: number; n: number }>()
    for (const r of universe) {
      if (r.changePct == null || !r.industry) continue
      const e = byInd.get(r.industry) ?? { sum: 0, n: 0 }
      e.sum += r.changePct
      e.n += 1
      byInd.set(r.industry, e)
    }
    return [...byInd.entries()]
      .filter(([, e]) => e.n >= 2)
      .map(([industry, e]) => ({ industry, changePct: e.sum / e.n }))
      .sort((a, b) => b.changePct - a.changePct)
  }, [universe])

  // Real, factual morning brief computed from data already loaded
  const { items: liveFilings } = useFilings()
  const brief = useMemo(() => {
    const rated = universe.filter((r) => r.changePct != null)
    const adv = rated.filter((r) => (r.changePct ?? 0) > 0).length
    const dec = rated.filter((r) => (r.changePct ?? 0) < 0).length
    const sorted = [...rated].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    const gainers = sorted.slice(0, 3)
    const losers = sorted.slice(-3).reverse()
    const nifty = indexQuotes.get('NIFTY 50')
    const fmtMover = (r: { symbol: string; changePct: number | null }) =>
      `${r.symbol} ${(r.changePct ?? 0) >= 0 ? '+' : ''}${(r.changePct ?? 0).toFixed(1)}%`
    const watch = liveFilings.filter((f) => f.materiality === 'high').slice(0, 4).map((f) => `${f.company} — ${f.category}`)
    return { adv, dec, total: rated.length, gainers, losers, fmtMover, nifty, watch }
  }, [universe, indexQuotes, liveFilings])

  async function toggleAlert(id: number, nextActive: boolean) {
    const r = await togglePriceAlert(id, nextActive)
    if (!r.ok) toast(r.error ?? 'Could not update the alert.')
    refreshAlerts()
  }

  const anyMenuOpen = pickerOpen || rangeOpen

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {anyMenuOpen && (
        <button
          className="fixed inset-0 z-30 cursor-default"
          onClick={() => { setPickerOpen(false); setRangeOpen(false) }}
          tabIndex={-1}
          aria-label="Close menus"
        />
      )}

      {/* ——— Main column ——— */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* Instrument toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative z-40">
            <button
              onClick={() => { setPickerOpen((o) => !o); setRangeOpen(false) }}
              className="flex items-center gap-2.5 rounded-full border border-line bg-surface py-1.5 pl-2 pr-3.5 shadow-sm transition hover:shadow-md"
            >
              <IndexBadge name={instrument.name} />
              <span className="text-[13px] font-bold text-ink">{instrument.name}</span>
              <span className="text-[11px] font-medium text-faint">NSE/BSE</span>
              <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: up ? '#e7f8f1' : '#fdeef0', color: up ? UP : DOWN }}>
                {up ? '+' : ''}{dispChange.toFixed(2)}%
              </span>
              <ChevronDown size={13} className={`text-faint transition-transform duration-200 ${pickerOpen ? 'rotate-180' : ''}`} />
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgba(16,24,40,0.14)]">
                {indices.map((i, n) => {
                  const q = indexQuotes.get(i.name)
                  return (
                    <button
                      key={i.name}
                      onClick={() => { setIdx(n); setPickerOpen(false) }}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold transition-colors ${n === idx ? 'bg-panel text-ink' : 'text-muted hover:bg-panel'}`}
                    >
                      <IndexBadge name={i.name} size={20} />
                      <span className="flex-1 text-left">{i.name}</span>
                      {q ? (
                        <span style={{ color: q.changePct >= 0 ? UP : DOWN }}>{q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="relative z-40">
            <button
              onClick={() => { setRangeOpen((o) => !o); setPickerOpen(false) }}
              title="Chart range"
              className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-muted shadow-sm transition hover:bg-panel"
            >
              {range.label} <ChevronDown size={12} className={`text-faint transition-transform duration-200 ${rangeOpen ? 'rotate-180' : ''}`} />
            </button>
            {rangeOpen && (
              <div className="absolute left-0 top-full z-40 mt-2 w-28 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgba(16,24,40,0.14)]">
                {RANGES.map((r) => (
                  <button
                    key={r.label}
                    onClick={() => { setRange(r); setRangeOpen(false) }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors ${range.label === r.label ? 'bg-panel text-ink' : 'text-muted hover:bg-panel'}`}
                  >
                    {r.label}
                    {range.label === r.label && <span className="text-up">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {dispSource === 'delayed' ? (
            <DataSourceBadge variant="delayed" />
          ) : dispSource === 'live' ? (
            <DataSourceBadge variant="live" label="NSE EOD" />
          ) : (
            <DataSourceBadge variant="sample" />
          )}

          <div className="ml-auto flex gap-2">
            <button onClick={() => setBriefOpen((o) => !o)} className="btn btn-fill !py-1.5 !text-[11.5px]">
              <Sparkle size={12} /> Morning brief
            </button>
            <Link to="/reports" className="btn btn-red !py-1.5 !text-[11.5px]">Compose report</Link>
          </div>
        </div>

        {/* Morning brief drawer — factual, computed from live data */}
        {briefOpen && (
          <div className="card stagger p-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[12.5px] font-bold text-ink">Morning brief</h3>
              <DataSourceBadge variant="live" label="Computed · live data" />
            </div>
            {brief.total > 0 ? (
              <>
                <p className="text-[12.5px] leading-relaxed text-muted">
                  {brief.nifty && (
                    <>
                      The NIFTY 50 is at <b className="text-ink">{brief.nifty.price.toLocaleString('en-IN')}</b>{' '}
                      (<span style={{ color: brief.nifty.changePct >= 0 ? UP : DOWN }}>{brief.nifty.changePct >= 0 ? '+' : ''}{brief.nifty.changePct.toFixed(2)}%</span>).{' '}
                    </>
                  )}
                  Breadth across the {brief.total} NIFTY 500 names tracked:{' '}
                  <b className="text-up">{brief.adv} advancing</b> vs <b className="text-down">{brief.dec} declining</b>.{' '}
                  Top movers: {brief.gainers.map(brief.fmtMover).join(', ')}. Laggards: {brief.losers.map(brief.fmtMover).join(', ')}.
                </p>
                {brief.watch.length > 0 && (
                  <div className="mt-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-faint">Watch items — high-materiality filings</div>
                    <ul className="mt-1 space-y-0.5">
                      {brief.watch.map((w) => (
                        <li key={w} className="text-[11.5px] text-muted">• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-muted">
                Market breadth is unavailable — the price store has no day-change data yet (run the daily ingest in <code>server/</code>).
              </p>
            )}
            <Disclaimer />
          </div>
        )}

        {/* Chart */}
        <div className="card flex min-h-[300px] min-w-0 flex-1 flex-col p-3 pb-2">
          <TradingChart data={candles} symbol={instrument.name} fill />
        </div>

        {/* Sector tape — real per-industry day change; click to filter the directory */}
        {topSectors.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-0.5">
            {topSectors.slice(0, 14).map((s) => (
              <button
                key={s.industry}
                onClick={() => navigate(`/companies?industry=${encodeURIComponent(s.industry)}`)}
                title={`Browse ${s.industry} companies`}
                className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-muted shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                {s.industry}
                <b style={{ color: s.changePct >= 0 ? UP : DOWN }}>
                  {s.changePct >= 0 ? '+' : ''}{s.changePct.toFixed(2)}%
                </b>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ——— Right rail (drops below the chart on small screens) ——— */}
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-[290px]">
        {/* Watchlist */}
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-bold text-ink">Watchlist</h3>
            <Link to="/watchlist" className="text-[11px] font-semibold text-faint transition-colors hover:text-ink">Edit</Link>
          </div>
          <div className="stagger">
            {watch.slice(0, 6).map((c) => (
              <button
                key={c.symbol}
                onClick={() => navigate(`/company/${c.symbol}`)}
                className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-2 text-left transition-colors hover:bg-panel"
              >
                <CompanyLogo domain={c.domain} symbol={c.symbol} sector={c.sector} size={24} />
                <span className="flex-1">
                  <span className="block text-[12.5px] font-bold leading-tight text-ink">{c.symbol}</span>
                  <span className="block text-[10px] leading-tight text-faint">{c.sector}</span>
                </span>
                <span className="text-right">
                  {(() => {
                    const lq = watchQuotes.get(c.symbol)
                    const price = lq?.price ?? c.price
                    const chg = lq?.changePct ?? c.dayChangePct
                    return (
                      <>
                        <span className="block font-mono text-[12px] font-semibold leading-tight text-ink">
                          {price.toLocaleString('en-IN')}
                        </span>
                        <span className="block text-[10.5px] font-bold leading-tight" style={{ color: chg >= 0 ? UP : DOWN }}>
                          {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
                        </span>
                      </>
                    )
                  })()}
                </span>
              </button>
            ))}
          </div>
          {/* Accordion sections */}
          <div className="mt-1 border-t border-line pt-1">
            {(['Shares', 'Futures', 'Cryptocurrencies'] as const).map((s) => {
              const open = openSection === s
              return (
                <div key={s}>
                  <button
                    onClick={() => setOpenSection(open ? null : s)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:bg-panel hover:text-strong"
                  >
                    <ChevronRight size={13} className={`text-faint transition-transform duration-200 ${open ? 'rotate-90' : ''}`} /> {s}
                  </button>
                  {open && s === 'Shares' && (
                    <div className="stagger max-h-44 overflow-y-auto pb-1 pl-2">
                      {companies.map((c) => (
                        <button
                          key={c.symbol}
                          onClick={() => navigate(`/company/${c.symbol}`)}
                          className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-panel"
                        >
                          <CompanyLogo domain={c.domain} symbol={c.symbol} sector={c.sector} size={18} />
                          <span className="flex-1 truncate text-[11.5px] font-semibold text-muted">{c.symbol}</span>
                          <span className="text-[10.5px] font-bold" style={{ color: c.dayChangePct >= 0 ? UP : DOWN }}>
                            {c.dayChangePct >= 0 ? '+' : ''}{c.dayChangePct.toFixed(2)}%
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {open && s !== 'Shares' && (
                    <p className="px-2 pb-2 pl-7 text-[11px] text-faint">Equities only for now — more asset classes are on the roadmap.</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Alerts */}
        <div className="card p-4">
          <div className="mb-3 flex rounded-full bg-panel p-1">
            {(['Alerts', 'History', 'System'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setAlertTab(t)}
                className={`flex-1 rounded-full py-1 text-[11px] font-bold transition-all duration-200 ${alertTab === t ? 'bg-surface text-ink shadow-sm' : 'text-faint hover:text-muted'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {alertTab === 'Alerts' && (
            <div className="stagger space-y-0.5">
              {alerts.length === 0 && (
                <p className="px-1.5 py-2 text-[11.5px] text-faint">
                  No alerts yet — open any company page and set one (e.g. "alert me below ₹190").
                </p>
              )}
              {alerts.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 rounded-xl px-1.5 py-2 transition-colors hover:bg-panel">
                  {a.active ? <Bell size={13} className="text-up" /> : <BellOff size={13} className="text-faint" />}
                  <button onClick={() => navigate(`/company/${a.symbol}`)} className="flex-1 text-left">
                    <span className="block text-[11.5px] font-semibold leading-snug text-ink">
                      {a.symbol} {a.condition === 'above' ? '≥' : '≤'} ₹{a.price.toLocaleString('en-IN')}
                    </span>
                    <span className="block text-[10px] text-faint">
                      live price check · set {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </button>
                  <button
                    onClick={() => toggleAlert(a.id, !a.active)}
                    role="switch"
                    aria-checked={a.active}
                    aria-label={a.active ? 'Pause alert' : 'Resume alert'}
                    title={a.active ? 'Pause alert' : 'Resume alert'}
                    className={`h-4 w-7 rounded-full p-0.5 transition-colors ${a.active ? 'bg-[#2ebd85]' : 'bg-line'}`}
                  >
                    <span className={`block h-3 w-3 rounded-full bg-surface shadow transition-transform duration-200 ${a.active ? 'translate-x-3' : ''}`} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {alertTab === 'History' && (
            <div className="stagger space-y-0.5">
              {alertHistory.length === 0 && (
                <p className="px-1.5 py-2 text-[11.5px] text-faint">Nothing fired yet — triggered alerts land here with the hit price.</p>
              )}
              {alertHistory.map((h) => (
                <button key={h.id} onClick={() => navigate(`/company/${h.symbol}`)} className="block w-full rounded-xl px-1.5 py-2 text-left transition-colors hover:bg-panel">
                  <span className="block text-[11.5px] font-semibold leading-snug text-muted">
                    {h.symbol} crossed {h.condition === 'above' ? '≥' : '≤'} ₹{h.price.toLocaleString('en-IN')} (hit ₹{h.triggerPrice?.toLocaleString('en-IN')})
                  </span>
                  <span className="block text-[10px] text-faint">
                    {h.triggeredAt ? new Date(h.triggeredAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          {alertTab === 'System' && (
            <div className="stagger space-y-0.5">
              {systemItems.map((s) => (
                <div key={s.id} className="rounded-xl px-1.5 py-2 transition-colors hover:bg-panel">
                  <span className="block text-[11.5px] font-semibold leading-snug text-muted">{s.text}</span>
                  <span className="block text-[10px] text-faint">{s.meta}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Instrument card */}
        <div className="card p-4">
          <div className="flex items-center gap-2.5">
            <IndexBadge name={instrument.name} size={28} />
            <span>
              <span className="block text-[13px] font-bold leading-tight text-ink">{instrument.name}</span>
              <span className="block text-[10px] leading-tight text-faint">
                Indian benchmark · {dispSource === 'delayed' ? 'delayed quote' : dispSource === 'live' ? 'NSE EOD' : 'sample'}
              </span>
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-[22px] font-bold tracking-tight text-ink">
              {dispValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
            <span className="text-[12px] font-bold" style={{ color: up ? UP : DOWN }}>
              {up ? '▲' : '▼'} {Math.abs(dispChange).toFixed(2)}%
            </span>
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-faint">Performance</div>
            <div className="grid grid-cols-3 gap-1.5">
              {perf.map((p) => (
                <div key={p.label} className="rounded-xl bg-panel px-2 py-2 text-center">
                  <div className="text-[12px] font-bold" style={{ color: p.v >= 0 ? UP : DOWN }}>
                    {p.v >= 0 ? '+' : ''}{p.v.toFixed(1)}%
                  </div>
                  <div className="text-[9.5px] font-semibold text-faint">{p.label}</div>
                </div>
              ))}
            </div>
          </div>
          <Link to="/companies" className="btn mt-3 w-full !py-2 !text-[11.5px]">
            Browse coverage →
          </Link>
        </div>
      </aside>
    </div>
  )
}
