// My Investments — PRIVATE owner-only mock portfolio (paper trading).
// Broker-app mechanics on real NSE EOD data with mock money: buy from the starred
// list (or any symbol), set stop-loss/target, and measure what the money would
// actually be doing. Server-gated exactly like the guidance desk (404 for non-owners).
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Lock, Star, Wallet, RefreshCw, X, Pencil, ShieldAlert, Crosshair, ScrollText, ChevronDown, BellRing } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Cell, ReferenceLine } from 'recharts'
import { PageHeader } from '../components/ui'
import { CompanySearch } from '../components/CompanySearch'
import { useAuth } from '../lib/auth'
import { useUniverse } from '../lib/api'
import {
  useGuidanceAccess, useStars, usePortfolio, usePortfolioLogs, useNotifications, placeOrder, closePtPosition, updatePtStops, resetPtAccount,
  type OpenPositionView, type Portfolio as PortfolioT, type PositionLog, type Notification,
} from '../lib/guidance'

const inr = (n: number | null | undefined, digits = 0): string =>
  n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`)
const col = (n: number | null | undefined) => (n == null ? 'text-faint' : n >= 0 ? 'text-up' : 'text-down')

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  'high-conviction': { label: 'high-conviction', color: '#1d9d6f' },
  constructive: { label: 'constructive', color: '#2186c4' },
  neutral: { label: 'neutral', color: '#8a8f99' },
  avoid: { label: 'avoid', color: '#c43a3a' },
}

export function Portfolio() {
  const access = useGuidanceAccess()
  const { pf, loading, reload } = usePortfolio(access.enabled)
  const stars = useStars(access.enabled)
  const [params, setParams] = useSearchParams()

  // ?buy=SYMBOL — arriving from the guidance detail panel pre-fills the ticket.
  const [ticketSym, setTicketSym] = useState('')
  useEffect(() => {
    const buy = params.get('buy')
    if (buy) { setTicketSym(buy.toUpperCase()); setParams({}, { replace: true }) }
  }, [params, setParams])

  if (access.loading) return <p className="text-[13px] italic text-faint">Checking access…</p>
  if (!access.enabled) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <Lock className="mx-auto mb-3 text-faint" size={28} />
        <h2 className="text-[15px] font-bold text-ink">Private desk</h2>
        <p className="mt-1.5 text-[12.5px] text-muted">This section isn’t available on this account.</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="My Investments" subtitle="Private mock portfolio — real prices, mock money, broker-style stop-loss & targets" />
      {pf && (
        <p className="mb-3 text-[11px] text-faint">{pf.note}</p>
      )}

      {/* Search any NIFTY-500 name → fills the order ticket (price pre-filled from its last close). */}
      <CompanySearch
        placeholder="Search any company to invest in (mock)…"
        onPick={(p) => setTicketSym(p.symbol)}
        className="mb-4 max-w-xl"
      />

      <SummaryRow pf={pf} loading={loading} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <OrderTicket
            symbol={ticketSym}
            onSymbol={setTicketSym}
            stars={stars.stars}
            onPlaced={() => { reload(); stars.reload() }}
          />
          <StarredPanel stars={stars} onInvest={(s) => setTicketSym(s)} />
        </div>
        <div className="space-y-4">
          <AdvisoryPanel enabled={access.enabled} />
          <OpenPositions pf={pf} loading={loading} onChanged={reload} />
          <TradeLogs enabled={access.enabled} />
          <TradeHistory pf={pf} />
          <DangerZone onReset={reload} />
        </div>
      </div>
    </div>
  )
}

function SummaryRow({ pf, loading }: { pf: PortfolioT | null; loading: boolean }) {
  const a = pf?.account
  const cells: { label: string; value: string; tone?: number | null }[] = [
    { label: 'Portfolio value', value: inr(a?.portfolioValue) },
    { label: 'Invested', value: inr(a?.invested) },
    { label: 'Available cash', value: inr(a?.cash) },
    { label: "Today's P&L", value: inr(a?.dayPnl), tone: a?.dayPnl },
    { label: 'Unrealized P&L', value: inr(a?.unrealizedPnl), tone: a?.unrealizedPnl },
    { label: 'Realized P&L', value: inr(a?.realizedPnl), tone: a?.realizedPnl },
    { label: 'Total return', value: a ? pct(a.totalReturnPct) : '—', tone: a?.totalReturnPct },
  ]
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {cells.map((c) => (
        <div key={c.label} className="rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm">
          <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-faint">{c.label}</div>
          <div className={`mt-0.5 text-[14px] font-bold tabular-nums ${c.tone != null ? col(c.tone) : 'text-ink'}`}>
            {loading && !pf ? '…' : c.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function OrderTicket({ symbol, onSymbol, stars, onPlaced }: {
  symbol: string
  onSymbol: (s: string) => void
  stars: { symbol: string; price: number | null }[]
  onPlaced: () => void
}) {
  const { token } = useAuth()
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [sl, setSl] = useState('')
  const [tgt, setTgt] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // pre-fill the price box with the latest close — universe quote first (covers every
  // NIFTY-500 name, incl. search picks), starred-list quote as fallback.
  const { rows: uni } = useUniverse()
  useEffect(() => {
    const sym = symbol.toUpperCase()
    const p = uni.find((r) => r.symbol === sym)?.close ?? stars.find((s) => s.symbol === sym)?.price
    if (p != null) setPrice(String(p))
  }, [symbol, stars, uni])

  const cost = useMemo(() => {
    const q = Number(qty)
    const p = Number(price)
    return Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0 ? q * p : null
  }, [qty, price])

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    const r = await placeOrder(token, {
      symbol: symbol.trim().toUpperCase(),
      qty: Number(qty),
      price: price.trim() ? Number(price) : undefined,
      stopLoss: sl.trim() ? Number(sl) : undefined,
      target: tgt.trim() ? Number(tgt) : undefined,
    })
    setBusy(false)
    if (r.ok) {
      setMsg({ ok: true, text: `Bought — filled at ₹${r.fillPrice} (market price, ${r.fillDate}).` })
      setQty(''); setSl(''); setTgt('')
      onPlaced()
    } else {
      setMsg({ ok: false, text: r.error ?? 'order failed' })
    }
  }

  const field = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] tabular-nums text-ink outline-none focus:border-[#2186c4]'
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Wallet size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Buy (mock order)</span>
      </div>
      <div className="mt-3 space-y-2.5">
        <label className="block">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Symbol</span>
          <input className={field} value={symbol} onChange={(e) => onSymbol(e.target.value.toUpperCase())} placeholder="e.g. LODHA" />
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Quantity</span>
            <input className={field} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" inputMode="numeric" />
          </label>
          <label className="block">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Price (blank = market)</span>
            <input className={field} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="market" inputMode="decimal" />
          </label>
          <label className="block">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Stop-loss ₹</span>
            <input className={field} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="optional" inputMode="decimal" />
          </label>
          <label className="block">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Target ₹</span>
            <input className={field} value={tgt} onChange={(e) => setTgt(e.target.value)} placeholder="optional" inputMode="decimal" />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] tabular-nums text-muted">{cost != null ? `Cost ≈ ${inr(cost)}` : ' '}</span>
          <button
            onClick={submit}
            disabled={busy || !symbol.trim() || !qty.trim()}
            className="rounded-lg bg-[#1d9d6f] px-4 py-1.5 text-[12.5px] font-bold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Placing…' : 'Buy'}
          </button>
        </div>
        {msg && <p className={`text-[11.5px] ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
      </div>
    </div>
  )
}

function StarredPanel({ stars, onInvest }: { stars: ReturnType<typeof useStars>; onInvest: (s: string) => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Star size={14} className="text-[#c9a03a]" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Starred — private watchlist</span>
        <span className="ml-auto text-[11px] tabular-nums text-faint">{stars.stars.length}</span>
      </div>
      {stars.stars.length === 0 && (
        <p className="mt-2 text-[12px] text-muted">
          Nothing starred yet — open a name in <Link to="/guidance" className="underline decoration-dotted">Investment Guidance</Link> and hit the ★ next to its title.
        </p>
      )}
      <div className="mt-2 divide-y divide-line">
        {stars.stars.map((s) => (
          <div key={s.symbol} className="flex items-center gap-2 py-2">
            <Link to={`/company/${encodeURIComponent(s.symbol)}`} className="group min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-ink group-hover:underline">{s.symbol}</span>
                <span className={`text-[11.5px] tabular-nums ${col(s.move1d)}`}>{pct(s.move1d)}</span>
              </div>
              <div className="truncate text-[11px] text-muted group-hover:underline">{s.name ?? '—'}</div>
            </Link>
            <span className="text-[12px] font-semibold tabular-nums text-strong">{s.price != null ? inr(s.price, 2) : '—'}</span>
            <button onClick={() => onInvest(s.symbol)} className="rounded-md border border-line px-2 py-1 text-[11px] font-bold text-strong transition hover:border-[#1d9d6f] hover:text-[#1d9d6f]">
              Invest
            </button>
            <button onClick={() => stars.toggle(s.symbol)} title="Unstar" className="rounded-md p-1 text-[#c9a03a] transition hover:opacity-70">
              <Star size={14} fill="currentColor" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function OpenPositions({ pf, loading, onChanged }: { pf: PortfolioT | null; loading: boolean; onChanged: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Crosshair size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Open positions</span>
        {loading && <RefreshCw size={12} className="animate-spin text-faint" />}
        <button onClick={onChanged} className="ml-auto text-[11px] text-faint underline decoration-dotted hover:text-muted">refresh</button>
      </div>
      {pf && pf.open.length === 0 && <p className="mt-2 text-[12px] text-muted">No open positions — place a mock buy to start tracking.</p>}
      <div className="mt-2 space-y-2">
        {(pf?.open ?? []).map((p) => <PositionRow key={p.id} p={p} onChanged={onChanged} />)}
      </div>
    </div>
  )
}

function PositionRow({ p, onChanged }: { p: OpenPositionView; onChanged: () => void }) {
  const { token } = useAuth()
  const [editing, setEditing] = useState(false)
  const [sl, setSl] = useState(p.stopLoss != null ? String(p.stopLoss) : '')
  const [tgt, setTgt] = useState(p.target != null ? String(p.target) : '')
  const [sellQty, setSellQty] = useState('')
  const [selling, setSelling] = useState(false)
  const [err, setErr] = useState('')
  const tier = p.tierAtEntry ? TIER_BADGE[p.tierAtEntry] : null

  const saveStops = async () => {
    const r = await updatePtStops(token, p.id, sl.trim() ? Number(sl) : null, tgt.trim() ? Number(tgt) : null)
    if (!r.ok) { setErr(r.error ?? 'failed'); return }
    setErr(''); setEditing(false); onChanged()
  }
  const sell = async () => {
    const r = await closePtPosition(token, p.id, sellQty.trim() ? { qty: Number(sellQty) } : {})
    if (!r.ok) { setErr(r.error ?? 'failed'); return }
    setErr(''); setSelling(false); setSellQty(''); onChanged()
  }

  const mini = 'w-24 rounded-md border border-line bg-surface px-2 py-1 text-[12px] tabular-nums text-ink outline-none focus:border-[#2186c4]'
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/company/${encodeURIComponent(p.symbol)}`} className="text-[13.5px] font-bold text-ink hover:underline">{p.symbol}</Link>
        <Link to={`/company/${encodeURIComponent(p.symbol)}`} className="truncate text-[11px] text-muted hover:underline">{p.name ?? ''}</Link>
        {tier && <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold" style={{ color: tier.color, background: tier.color + '18' }}>at entry: {tier.label}</span>}
        <span className={`ml-auto text-[13.5px] font-bold tabular-nums ${col(p.pnl)}`}>{inr(p.pnl)} <span className="text-[11px] font-semibold">({pct(p.pnlPct)})</span></span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] tabular-nums text-muted sm:grid-cols-4 lg:grid-cols-6">
        <span>Qty <b className="text-strong">{p.qty}</b></span>
        <span>Avg <b className="text-strong">{inr(p.entryPrice, 2)}</b></span>
        <span>LTP <b className="text-strong">{p.ltp != null ? inr(p.ltp, 2) : '—'}</b> <span className={col(p.dayChangePct)}>{pct(p.dayChangePct)}</span></span>
        <span>Value <b className="text-strong">{inr(p.value)}</b></span>
        <span>SL <b className="text-strong">{p.stopLoss != null ? inr(p.stopLoss, 2) : '—'}</b></span>
        <span>Target <b className="text-strong">{p.target != null ? inr(p.target, 2) : '—'}</b></span>
        <span title="Your return minus NIFTY's return over the same holding period — beating the index is the real scoreboard">vs NIFTY <b className={col(p.vsNiftyPct)}>{pct(p.vsNiftyPct)}</b></span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-faint">
        <span>Bought {p.entryDate}{p.ltpDate ? ` · marked to ${p.ltpLive ? 'live quote (~15-min delayed)' : `${p.ltpDate} close`}` : ''}</span>
        {p.ltpLive && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#2ebd85]" />}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!editing && !selling && (
          <>
            <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-strong hover:border-[#2186c4] hover:text-[#2186c4]"><Pencil size={11} /> SL / target</button>
            <button onClick={() => setSelling(true)} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-strong hover:border-[#c43a3a] hover:text-[#c43a3a]"><X size={11} /> Exit</button>
          </>
        )}
        {editing && (
          <>
            <input className={mini} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="SL ₹" inputMode="decimal" />
            <input className={mini} value={tgt} onChange={(e) => setTgt(e.target.value)} placeholder="Target ₹" inputMode="decimal" />
            <button onClick={saveStops} className="rounded-md bg-[#2186c4] px-2.5 py-1 text-[11px] font-bold text-white">Save</button>
            <button onClick={() => { setEditing(false); setErr('') }} className="text-[11px] text-faint underline decoration-dotted">cancel</button>
          </>
        )}
        {selling && (
          <>
            <input className={mini} value={sellQty} onChange={(e) => setSellQty(e.target.value)} placeholder={`qty (max ${p.qty})`} inputMode="numeric" />
            <button onClick={sell} className="rounded-md bg-[#c43a3a] px-2.5 py-1 text-[11px] font-bold text-white">Sell at market</button>
            <button onClick={() => { setSelling(false); setErr('') }} className="text-[11px] text-faint underline decoration-dotted">cancel</button>
          </>
        )}
        {err && <span className="text-[11px] text-down">{err}</span>}
      </div>
    </div>
  )
}

// ——— Sell advisor — the desk's risk advisories on YOUR holdings, evidence attached ———
const SEV_META: Record<Notification['severity'], { color: string; label: string }> = {
  urgent: { color: '#c43a3a', label: 'sell now?' },
  warn: { color: '#c9a03a', label: 'sell soon?' },
  info: { color: '#2186c4', label: 'fyi' },
}

function AdvisoryPanel({ enabled }: { enabled: boolean }) {
  const { items, unread, loading, markRead } = useNotifications(enabled)
  const [showAll, setShowAll] = useState(false)
  if (!enabled || (!loading && items.length === 0)) return null
  const shown = showAll ? items : items.filter((n) => !n.readAt).slice(0, 8)
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <BellRing size={14} className={unread > 0 ? 'text-[#c43a3a]' : 'text-faint'} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Sell advisor — risk alerts on your holdings</span>
        {unread > 0 && <span className="rounded-full bg-[#fdecec] px-2 py-0.5 text-[10px] font-bold text-[#c43a3a]">{unread} new</span>}
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setShowAll((s) => !s)} className="text-[11px] text-faint underline decoration-dotted hover:text-muted">{showAll ? 'unread only' : `history (${items.length})`}</button>
          {unread > 0 && <button onClick={() => markRead()} className="text-[11px] text-faint underline decoration-dotted hover:text-muted">mark all read</button>}
        </div>
      </div>
      {shown.length === 0 && <p className="mt-2 text-[12px] text-muted">Nothing new — the advisor reviews every holding after each session's close.</p>}
      <div className="mt-2 space-y-2">
        {shown.map((n) => {
          const m = SEV_META[n.severity]
          return (
            <div key={n.id} className="rounded-xl border p-3" style={{ borderColor: m.color + '55', background: n.readAt ? undefined : m.color + '0d' }}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase" style={{ color: m.color, background: m.color + '1a' }}>{m.label}</span>
                <span className="text-[12.5px] font-bold text-ink">{n.title}</span>
                <span className="ml-auto text-[10px] tabular-nums text-faint">{n.createdAt.slice(0, 10)}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-strong">{n.body}</p>
              {n.fact && <FactLineP fact={n.fact} />}
              {!n.readAt && <button onClick={() => markRead(n.id)} className="mt-1.5 text-[10.5px] font-semibold text-faint underline decoration-dotted hover:text-muted">mark read</button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Fact line with a clickable source when it carries a URL (same idiom as the guidance desk).
function FactLineP({ fact }: { fact: string }) {
  const m = fact.match(/https?:\/\/\S+/)
  const body = m ? fact.slice(0, m.index).replace(/\s*—\s*$/, '') : fact
  return (
    <p className="mt-1 text-[10.5px] leading-snug text-faint">
      Basis: {body}
      {m && <> — <a href={m[0]} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-muted">source</a></>}
    </p>
  )
}

// ——— Trade logs: today's damage report + per-company daily growth/loss since entry ———
const GAIN = '#1d9d6f'
const LOSS = '#c43a3a'

function TradeLogs({ enabled }: { enabled: boolean }) {
  const { logs, note, loading } = usePortfolioLogs(enabled)
  if (!loading && logs.length === 0) return null
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <ScrollText size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Trade logs — day by day, per company</span>
        {loading && <RefreshCw size={12} className="animate-spin text-faint" />}
      </div>

      {/* today's damage report — every open name's contribution, worst hit first */}
      {logs.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {logs.map((l) => (
            <span key={l.id} className="rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums" style={{ background: (l.todayPnl ?? 0) >= 0 ? '#e7f8f1' : '#fdecec', color: (l.todayPnl ?? 0) >= 0 ? GAIN : LOSS }}>
              {l.symbol} today {l.todayPnl != null ? `${l.todayPnl >= 0 ? '+' : '−'}${inr(Math.abs(l.todayPnl))}` : '—'}{l.todayPct != null ? ` (${pct(l.todayPct)})` : ''}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-3">
        {logs.map((l) => <PositionLogCard key={l.id} log={l} />)}
      </div>
      {note && <p className="mt-2 text-[10.5px] text-faint">{note}</p>}
    </div>
  )
}

function PositionLogCard({ log }: { log: PositionLog }) {
  const [open, setOpen] = useState(false)
  const chart = log.series.map((s) => ({ ...s, d: s.date.slice(5) })) // MM-DD labels
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/company/${encodeURIComponent(log.symbol)}`} className="text-[13px] font-bold text-ink hover:underline">{log.symbol}</Link>
        <span className="truncate text-[11px] text-muted">{log.name ?? ''}</span>
        <span className="text-[10.5px] tabular-nums text-faint">invested {log.entryDate} · {log.qty} × {inr(log.entryPrice, 2)}</span>
        <span className={`ml-auto text-[12.5px] font-bold tabular-nums ${col(log.totalPnl)}`}>since entry {log.totalPnl != null ? inr(log.totalPnl) : '—'}</span>
      </div>

      {/* per-day growth/loss bars + cumulative line */}
      {chart.length > 0 && (
        <div className="mt-2 h-36">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="d" tick={{ fontSize: 9, fill: '#9aa0ab' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
              <YAxis tick={{ fontSize: 9, fill: '#9aa0ab' }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => `₹${Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}`} />
              <Tooltip
                formatter={(v, name) => [inr(Number(v)), String(name) === 'dayPnl' ? 'that day' : 'since entry']}
                labelFormatter={(_, pl) => {
                  const p = pl?.[0]?.payload as PositionLog['series'][number] | undefined
                  return p ? `${p.date}${p.live ? ' (live)' : ''} · close ₹${p.close}` : ''
                }}
                contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid #e5e7eb' }}
              />
              <ReferenceLine y={0} stroke="#d3d6dd" />
              <Bar dataKey="dayPnl" maxBarSize={14} radius={[3, 3, 0, 0]}>
                {chart.map((s, i) => <Cell key={i} fill={s.dayPnl >= 0 ? GAIN : LOSS} fillOpacity={0.75} />)}
              </Bar>
              <Line type="monotone" dataKey="cumPnl" stroke="#16181d" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* full daily log, newest first */}
      <button onClick={() => setOpen((o) => !o)} className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-faint hover:text-muted">
        <ChevronDown size={12} className={`transition-transform ${open ? '' : '-rotate-90'}`} /> daily log ({log.series.length} sessions)
      </button>
      {open && (
        <div className="mt-1 max-h-52 overflow-y-auto">
          <table className="w-full text-[11.5px] tabular-nums">
            <thead>
              <tr className="border-b border-line text-left text-[9.5px] uppercase tracking-wide text-faint">
                <th className="py-1 pr-2 font-semibold">Date</th>
                <th className="px-2 py-1 text-right font-semibold">Close</th>
                <th className="px-2 py-1 text-right font-semibold">That day</th>
                <th className="px-2 py-1 text-right font-semibold">Since entry</th>
              </tr>
            </thead>
            <tbody>
              {[...log.series].reverse().map((s) => (
                <tr key={s.date} className="border-b border-line/50">
                  <td className="py-1 pr-2 text-muted">{s.date}{s.live ? ' · live' : ''}</td>
                  <td className="px-2 py-1 text-right text-strong">{inr(s.close, 2)}</td>
                  <td className={`px-2 py-1 text-right font-semibold ${col(s.dayPnl)}`}>{inr(s.dayPnl)}</td>
                  <td className={`px-2 py-1 text-right font-semibold ${col(s.cumPnl)}`}>{inr(s.cumPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const EXIT_BADGE: Record<string, { label: string; color: string }> = {
  'stop-loss': { label: 'stop-loss hit', color: '#c43a3a' },
  target: { label: 'target hit', color: '#1d9d6f' },
  manual: { label: 'manual exit', color: '#8a8f99' },
}

function TradeHistory({ pf }: { pf: PortfolioT | null }) {
  if (!pf || pf.closed.length === 0) return null
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Trade history</span>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-faint">
              <th className="py-1 pr-3 font-semibold">Name</th>
              <th className="px-2 py-1 text-right font-semibold">Qty</th>
              <th className="px-2 py-1 text-right font-semibold">Buy → Sell</th>
              <th className="px-2 py-1 text-right font-semibold">Held</th>
              <th className="px-2 py-1 font-semibold">Exit</th>
              <th className="px-2 py-1 text-right font-semibold">P&L</th>
              <th className="px-2 py-1 text-right font-semibold" title="Trade return minus NIFTY's return over the same window">α vs NIFTY</th>
            </tr>
          </thead>
          <tbody>
            {pf.closed.map((t) => {
              const badge = EXIT_BADGE[t.exitReason] ?? EXIT_BADGE.manual
              return (
                <tr key={t.id} className="border-b border-line/60">
                  <td className="py-1.5 pr-3"><Link to={`/company/${encodeURIComponent(t.symbol)}`} className="font-bold text-ink hover:underline">{t.symbol}</Link></td>
                  <td className="px-2 py-1.5 text-right">{t.qty}</td>
                  <td className="px-2 py-1.5 text-right">{inr(t.entryPrice, 2)} → {inr(t.exitPrice, 2)}</td>
                  <td className="px-2 py-1.5 text-right text-muted">{t.entryDate} → {t.exitDate}</td>
                  <td className="px-2 py-1.5"><span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold" style={{ color: badge.color, background: badge.color + '18' }}>{badge.label}</span></td>
                  <td className={`px-2 py-1.5 text-right font-bold ${col(t.pnl)}`}>{inr(t.pnl)} ({pct(t.pnlPct)})</td>
                  <td className={`px-2 py-1.5 text-right font-bold ${col(t.alphaPct)}`}>{pct(t.alphaPct)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DangerZone({ onReset }: { onReset: () => void }) {
  const { token } = useAuth()
  const [confirming, setConfirming] = useState(false)
  const [capital, setCapital] = useState('10000000')
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Reset mock account</span>
        {!confirming && (
          <button onClick={() => setConfirming(true)} className="ml-auto rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-[#c43a3a] hover:text-[#c43a3a]">Reset…</button>
        )}
        {confirming && (
          <span className="ml-auto flex items-center gap-2">
            <input className="w-32 rounded-md border border-line bg-surface px-2 py-1 text-[12px] tabular-nums text-ink outline-none" value={capital} onChange={(e) => setCapital(e.target.value)} inputMode="numeric" />
            <button
              onClick={async () => { await resetPtAccount(token, Number(capital) || undefined); setConfirming(false); onReset() }}
              className="rounded-md bg-[#c43a3a] px-2.5 py-1 text-[11px] font-bold text-white"
            >
              Wipe ALL trades & restart
            </button>
            <button onClick={() => setConfirming(false)} className="text-[11px] text-faint underline decoration-dotted">cancel</button>
          </span>
        )}
      </div>
      <p className="mt-1 text-[10.5px] text-faint">Deletes every open and closed mock position and restores the cash balance. Cannot be undone.</p>
    </div>
  )
}
