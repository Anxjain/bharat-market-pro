// Investment Guidance — PRIVATE owner-only decision-support desk.
// Renders the conviction tier ALONGSIDE its evidence: the full factor stack, the
// measured historical base rate (with misses + worst case), the thesis-breakers, and
// a grounded bull/bear/what-breaks brief. Never a bare "BUY".
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Lock, ShieldAlert, Sparkles, TrendingDown, TrendingUp, RefreshCw, Activity, SlidersHorizontal, Plus, X, AlertTriangle, Coins, Info, ChevronDown, ArrowDownCircle, Radar, CheckCircle2, Flame, Star, Users } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  useGuidanceAccess, useWatchlist, useSignal, useAnalyst, useBoard, useTrackRecord, useCalibration, useGuidanceHistory, useRegime, useStreaks, useStars, useAccessUsers, useMomentum, useGrading, grantAccess, revokeAccess, startScan, addWatch, removeWatch, getConfig, setConfig,
  type WatchFlag, type Signal, type BaseRate, type Factor, type FactorGroup, type Reason, type Opportunity, type Fundamentals, type TrackRecord, type Regime,
} from '../lib/guidance'
import { TradingChart } from '../components/TradingChart'
import { CompanySearch } from '../components/CompanySearch'

const TIER_META: Record<Signal['tier'], { label: string; color: string; bg: string }> = {
  'high-conviction': { label: 'High-conviction buy setup', color: '#1d9d6f', bg: '#e7f8f1' },
  constructive: { label: 'Constructive', color: '#2186c4', bg: '#e8f3fb' },
  neutral: { label: 'Neutral', color: '#8a8f99', bg: '#f1f2f5' },
  avoid: { label: 'Avoid', color: '#c43a3a', bg: '#fdecec' },
}
const GROUP_LABEL: Record<FactorGroup, string> = {
  price: 'Price / technical', relative: 'Relative / peers', catalyst: 'Catalyst', news: 'News / sentiment', fundamental: 'Fundamentals', risk: 'Risk / structural',
}
const GAIN = '#1d9d6f'
const LOSS = '#c43a3a'
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`)
const col = (n: number | null | undefined) => (n == null ? 'text-faint' : n >= 0 ? 'text-up' : 'text-down')

export function Guidance() {
  const access = useGuidanceAccess()
  const { flags, loading: wlLoading, reload } = useWatchlist(access.enabled)
  const [sel, setSel] = useState<string | null>(null)
  const { sig, loading: sigLoading } = useSignal(sel)

  // Selecting a name from anywhere (Today's buys strip, board cards, movers, watchlist)
  // must also BRING THE READER to the verdict — the detail panel lives below the board /
  // track-record / calibration sections, so without a scroll a click looks like a no-op.
  const detailRef = useRef<HTMLDivElement>(null)
  const select = useCallback((s: string) => {
    setSel(s)
    // Let the (possibly "Computing signal…") panel render first, then scroll to it —
    // fires on every click, including re-clicking the same name after scrolling away.
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  }, [])

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
      <PageHeader title="Investment Guidance" subtitle="Private decision-support — evidence-weighted setups, not outcome guarantees" />
      <div className="mb-4 rounded-xl border border-warn-soft bg-warn-soft px-3.5 py-2 text-[11.5px] text-[#8a7322]">
        Private decision-support. Signals are evidence-weighted <b>setups, not outcome guarantees</b>. Base rates are historical and <b>include the failures</b>.
        <span className="mt-1 block text-[11px] text-[#9a833a]">
          Heads-up on the odds: base rates are <b>survivor-conditioned</b> — they’re measured over names that are <i>still listed</i> today, so delisted / suspended / distress-merged outcomes are missing and recovery frequencies read <b>optimistically</b> (most so for deep small/mid-cap dips). Where NIFTY 500 membership history is available, a <b>point-in-time universe</b> is applied instead and the base-rate card says so. Read the rest as “best-among-survivors”, not the full distribution. See GUIDANCE.md → base rate.
        </span>
      </div>

      {/* Search any NIFTY-500 name → its full verdict (scrolls to the detail panel). */}
      <CompanySearch
        placeholder="Search any company — verdict, factor stack, odds…"
        onPick={(p) => select(p.symbol)}
        className="max-w-xl"
      />

      <StreakStrip enabled={access.enabled} sel={sel} onSelect={select} />

      <RegimeBadge enabled={access.enabled} />

      <MomentumPanel enabled={access.enabled} sel={sel} onSelect={select} />

      <OpportunityBoard enabled={access.enabled} sel={sel} onSelect={select} watchFlags={flags} />

      <TrackRecordPanel enabled={access.enabled} />
      <GradingPanel enabled={access.enabled} />
      <CalibrationPanel enabled={access.enabled} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[330px_1fr]">
        <WatchlistPanel flags={flags} loading={wlLoading} sel={sel} onSelect={select} onReload={reload} />
        <div ref={detailRef} className="scroll-mt-4">
          {!sel && <Empty msg="Pick a name to see its conviction tier, full factor stack and historical base rate." />}
          {sel && sigLoading && <Empty msg={`Computing signal for ${sel} — assembling factors + base rate…`} spin />}
          {sel && !sigLoading && sig && <SignalDetail sig={sig} symbol={sel} />}
          {sel && !sigLoading && !sig && <Empty msg={`Couldn’t compute a signal for ${sel}.`} />}
        </div>
      </div>

      <TuningPanel flags={flags} reload={reload} />
      {access.admin && <AccessPanel />}
    </div>
  )
}

// ——— Manage access (ADMIN only — the env-listed owners) ———
// Grant/revoke members from the app: a granted email gets Investment Guidance +
// its own My Investments portfolio the moment they log in to this site with
// that address. No SSH, no restart.
function AccessPanel() {
  const { token } = useAuth()
  const [open, setOpen] = useState(false)
  const { admins, users, pending, loading, reload } = useAccessUsers(open)
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')

  const add = async (addr?: string) => {
    const r = await grantAccess(token, (addr ?? email).trim())
    if (!r.ok) { setMsg(r.error ?? 'failed'); return }
    setMsg(''); setEmail(''); reload()
  }

  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Users size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Manage access — who can use the investment sections</span>
        <span className="ml-auto text-[11px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="border-t border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              placeholder="new-user@gmail.com"
              className="w-72 max-w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-[#2186c4]"
            />
            <button onClick={() => add()} disabled={!email.trim()} className="rounded-lg bg-[#1d9d6f] px-3.5 py-1.5 text-[12px] font-bold text-white disabled:opacity-40">
              Grant access
            </button>
            {msg && <span className="text-[11.5px] text-down">{msg}</span>}
          </div>
          <p className="mt-1.5 text-[10.5px] text-faint">
            They sign up / log in to this site with exactly this email → the sections appear in their nav with a fresh ₹1&nbsp;crore mock account. Revoking hides the sections but keeps their data (re-granting restores it).
          </p>

          {/* Registered logins awaiting approval — everyone who has signed in to the site
              but hasn't been granted access yet. */}
          {pending.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Signed up — awaiting approval ({pending.length})</div>
              <div className="divide-y divide-line">
                {pending.map((p) => (
                  <div key={p.userEmail} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                    <span className="text-ink">{p.userEmail}</span>
                    <span className="text-[10.5px] text-faint">last seen {p.lastSeen.slice(0, 10)}</span>
                    <button onClick={() => add(p.userEmail)} className="ml-auto rounded-md bg-[#1d9d6f] px-2.5 py-0.5 text-[10.5px] font-bold text-white transition hover:opacity-90">
                      Approve
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 divide-y divide-line">
            {admins.map((a) => (
              <div key={a} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <span className="text-ink">{a}</span>
                <span className="rounded-full bg-panel px-2 py-0.5 text-[9.5px] font-bold uppercase text-faint" title="Admins are set via GUIDANCE_OWNER_EMAILS on the server">admin</span>
              </div>
            ))}
            {users.map((u) => (
              <div key={u.userEmail} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <span className="text-ink">{u.userEmail}</span>
                <span className="text-[10.5px] text-faint">added {u.addedAt.slice(0, 10)} by {u.addedBy}</span>
                <button
                  onClick={async () => { await revokeAccess(token, u.userEmail); reload() }}
                  className="ml-auto rounded-md border border-line px-2 py-0.5 text-[10.5px] font-semibold text-muted transition hover:border-[#c43a3a] hover:text-[#c43a3a]"
                >
                  Revoke
                </button>
              </div>
            ))}
            {!loading && users.length === 0 && <p className="py-1.5 text-[11.5px] text-muted">No members yet — only the admins above have access.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function TuningPanel({ flags, reload }: { flags: WatchFlag[]; reload: () => void }) {
  const { token } = useAuth()
  const [open, setOpen] = useState(false)
  const [sym, setSym] = useState('')
  const [thesis, setThesis] = useState('')
  const [tags, setTags] = useState('')
  const [weights, setWeights] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => {
    if (open && !weights) getConfig(token).then((c) => setWeights(JSON.stringify(c.weights ?? {}, null, 2))).catch(() => {})
  }, [open, token, weights])

  const add = async () => {
    if (!sym.trim()) return
    await addWatch(token, sym.trim().toUpperCase(), thesis.trim(), tags.split(',').map((t) => t.trim()).filter(Boolean))
    setSym(''); setThesis(''); setTags(''); reload()
  }
  const saveWeights = async () => {
    try { await setConfig(token, 'weights', JSON.parse(weights || '{}')); setSaved('saved ✓'); setTimeout(() => setSaved(''), 2000); reload() }
    catch { setSaved('invalid JSON'); setTimeout(() => setSaved(''), 2000) }
  }

  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <SlidersHorizontal size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Tune — watchlist & factor weights</span>
        <span className="ml-auto text-[11px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="grid gap-5 border-t border-line p-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-faint">Add to watchlist</div>
            <div className="space-y-2">
              <input value={sym} onChange={(e) => setSym(e.target.value)} placeholder="Symbol (e.g. SBIN)" className="w-full rounded-lg border border-line px-3 py-1.5 text-[12.5px] outline-none focus:border-[#7a5cff]" />
              <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="Why watched (thesis note)" className="w-full rounded-lg border border-line px-3 py-1.5 text-[12.5px] outline-none focus:border-[#7a5cff]" />
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma-separated (e.g. psu, financials)" className="w-full rounded-lg border border-line px-3 py-1.5 text-[12.5px] outline-none focus:border-[#7a5cff]" />
              <button onClick={add} className="inline-flex items-center gap-1.5 rounded-lg bg-inkfill px-3 py-1.5 text-[12px] font-semibold text-white"><Plus size={13} /> Add</button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {flags.map((f) => (
                <span key={f.symbol} className="inline-flex items-center gap-1 rounded-md bg-panel px-2 py-0.5 text-[11px] text-muted">
                  {f.symbol}
                  <button onClick={async () => { await removeWatch(token, f.symbol); reload() }} className="text-faint hover:text-down" title="Remove"><X size={11} /></button>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-faint">Factor weight overrides (JSON: {'{ "code": weight }'})</div>
            <textarea value={weights} onChange={(e) => setWeights(e.target.value)} rows={8} className="w-full rounded-lg border border-line p-2.5 font-mono text-[11.5px] outline-none focus:border-[#7a5cff]" placeholder='{ "rsi_14": 1.5, "dilution_flag": 2.0 }' />
            <div className="mt-2 flex items-center gap-2">
              <button onClick={saveWeights} className="rounded-lg bg-inkfill px-3 py-1.5 text-[12px] font-semibold text-white">Save weights</button>
              {saved && <span className="text-[11.5px] text-muted">{saved}</span>}
            </div>
            <p className="mt-1.5 text-[10.5px] text-faint">Override the default weight of any factor by its code (shown on hover in the factor stack). Empty = use defaults.</p>
          </div>
        </div>
      )}
    </div>
  )
}

function Empty({ msg, spin }: { msg: string; spin?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-5 text-[12.5px] italic text-faint shadow-sm">
      {spin && <RefreshCw size={14} className="animate-spin" />} {msg}
    </div>
  )
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TR_TIER_LABEL: Record<string, { label: string; color: string }> = {
  'high-conviction': { label: 'High-conviction', color: '#1d9d6f' },
  constructive: { label: 'Constructive', color: '#2186c4' },
  neutral: { label: 'Neutral', color: '#8a8f99' },
  avoid: { label: 'Avoid', color: '#c43a3a' },
}

function TrackRecordPanel({ enabled }: { enabled: boolean }) {
  const { data, loading } = useTrackRecord(enabled)
  const [open, setOpen] = useState(true)
  if (!enabled) return null
  const horizons = data?.horizons ?? [5, 20, 60]

  const TierTable = ({ rows }: { rows: TrackRecord['tiers'] }) => {
    const tiers = ['high-conviction', 'constructive', 'neutral', 'avoid'].filter((t) => rows.some((x) => x.tier === t))
    const cell = (tier: string, h: number) => rows.find((t) => t.tier === tier && t.horizon === h)
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-faint">
              <th className="py-1.5 pr-3 font-semibold">Verdict tier</th>
              {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right font-semibold">{h}d hit · avg</th>)}
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier} className="border-b border-line/60 last:border-0">
                <td className="py-2 pr-3 font-semibold" style={{ color: TR_TIER_LABEL[tier]?.color }}>{TR_TIER_LABEL[tier]?.label ?? tier}</td>
                {horizons.map((h) => {
                  const s = cell(tier, h)
                  if (!s) return <td key={h} className="px-2 py-2 text-right text-faint">—</td>
                  return (
                    <td key={h} className="px-2 py-2 text-right font-mono">
                      <span className={s.hitRate >= 50 ? 'text-up' : 'text-down'}>{s.hitRate}%</span>
                      <span className="text-faint"> · </span>
                      <span className={s.avgReturn >= 0 ? 'text-up' : 'text-down'}>{s.avgReturn > 0 ? '+' : ''}{s.avgReturn}%</span>
                      <span className="block text-[9.5px] text-faint">n={s.n.toLocaleString()} · worst {s.worst}%</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="card mt-4 p-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-[#7a5cff]" />
          <h3 className="text-[13.5px] font-bold text-ink">Track record — how the desk’s own calls do</h3>
          {data && <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-faint">{data.totalCalls} logged · {data.evaluated} measured</span>}
        </div>
        <ChevronDown size={16} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3">
          {loading && <p className="py-4 text-[12px] text-faint">Measuring realized outcomes…</p>}
          {!loading && data && data.evaluated > 0 ? (
            <><TierTable rows={data.tiers} /><p className="mt-1.5 text-[10.5px] text-faint">{data.note}</p></>
          ) : !loading && (
            <p className="py-1 text-[12px] leading-relaxed text-muted">
              The desk logs a daily snapshot of every verdict; each becomes measurable once ~1 week old (20d/60d over 1–3 months). For the immediate, universe-wide historical read, see <b>Setup calibration</b> below — it validates the timing axis over 30 years of data (180k setups) with confidence intervals.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const REGIME_META: Record<Regime['label'], { label: string; color: string; bg: string; icon: typeof TrendingUp }> = {
  'risk-on': { label: 'Risk-on', color: '#1d9d6f', bg: '#e7f8f1', icon: TrendingUp },
  neutral: { label: 'Neutral', color: '#b7791f', bg: '#fbf5e8', icon: Activity },
  'risk-off': { label: 'Risk-off', color: '#c43a3a', bg: '#fdecec', icon: TrendingDown },
}

// ——— 5-day winning streaks — the daily all-companies price record, read as a screen ———
// Top 5 names that closed HIGHER every single one of the last 5 sessions (not one down
// day), ranked by cumulative gain. Sits above every section so it's the first read;
// clicking a name computes its full signal in the detail panel below.
function StreakStrip({ enabled, sel, onSelect }: { enabled: boolean; sel: string | null; onSelect: (s: string) => void }) {
  const { streaks, loading } = useStreaks(enabled)
  if (!enabled) return null
  return (
    <div className="mt-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Flame size={14} className="self-center" style={{ color: GAIN }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">5-day winning streaks</span>
        <span className="text-[11px] text-faint">
          up every single session{streaks?.asOf ? ` · as of ${streaks.asOf}` : ''}
        </span>
      </div>
      {loading && !streaks && <p className="mt-2 text-[12px] italic text-faint">Reading the daily price record…</p>}
      {streaks && streaks.entries.length === 0 && <p className="mt-2 text-[12px] text-muted">{streaks.note}</p>}
      {streaks && streaks.entries.length > 0 && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {streaks.entries.map((e) => (
              <button
                key={e.symbol}
                onClick={() => onSelect(e.symbol)}
                className={`rounded-xl border p-2.5 text-left transition ${sel === e.symbol ? 'border-[#1d9d6f] bg-[#e7f8f1]' : 'border-line bg-surface hover:border-[#1d9d6f66]'}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] font-bold text-ink">{e.symbol}</span>
                  <span className="shrink-0 text-[13px] font-bold text-up">{pct(e.totalPct)}</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted">{e.name ?? '—'}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {e.dailyPct.map((d, i) => (
                    <span key={i} className="rounded bg-[#e7f8f1] px-1 py-0.5 text-[9.5px] font-semibold tabular-nums text-[#1d9d6f]">
                      +{d.toFixed(1)}
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10.5px] tabular-nums text-faint">₹{e.price.toFixed(2)} · ₹{e.avgTurnoverCr}cr/day</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10.5px] text-faint">{streaks.note}</p>
        </>
      )}
    </div>
  )
}

// ——— Momentum board — the core list for the 3–18 month holder ———
// 6m/3m relative strength (recent month skipped, the way the evidence says to do it),
// liquidity-filtered, quality-gated, with the earnings-trend confirmation next to each
// name. Meant to be acted on monthly, not churned daily.
const EARN_META: Record<string, { label: string; color: string }> = {
  improving: { label: 'earnings ↑ confirming', color: '#1d9d6f' },
  deteriorating: { label: 'earnings ↓ TRAP RISK', color: '#c43a3a' },
  mixed: { label: 'earnings mixed', color: '#8a8f99' },
}

function MomentumPanel({ enabled, sel, onSelect }: { enabled: boolean; sel: string | null; onSelect: (s: string) => void }) {
  const { board, loading } = useMomentum(enabled)
  const [open, setOpen] = useState(true)
  if (!enabled) return null
  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <TrendingUp size={14} style={{ color: GAIN }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Momentum board — ride the next 2 quarters</span>
        {loading && <RefreshCw size={12} className="animate-spin text-faint" />}
        {board?.asOf && <span className="text-[10.5px] text-faint">as of {board.asOf}</span>}
        <span className="ml-auto text-[11px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="border-t border-line p-4 pt-3">
          {!board && loading && <p className="text-[12px] italic text-faint">Ranking the universe…</p>}
          {board && board.entries.length === 0 && (
            <p className="text-[12px] text-muted">Not enough deep history yet — the full-universe backfill fills this in. {board.note}</p>
          )}
          {board && board.entries.length > 0 && (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {board.entries.map((e) => {
                  const em = e.earnings ? EARN_META[e.earnings] : null
                  return (
                    <button
                      key={e.symbol}
                      onClick={() => onSelect(e.symbol)}
                      className={`rounded-xl border p-2.5 text-left transition ${sel === e.symbol ? 'border-[#1d9d6f] bg-[#e7f8f1]' : 'border-line bg-surface hover:border-[#1d9d6f66]'}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-bold text-ink">#{e.rank} {e.symbol}</span>
                        <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-up">+{e.score.toFixed(1)}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted">{e.name ?? '—'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] tabular-nums text-faint">
                        <span>6m {e.m6 >= 0 ? '+' : ''}{e.m6.toFixed(0)}%</span>
                        <span>· 3m {e.m3 >= 0 ? '+' : ''}{e.m3.toFixed(0)}%</span>
                        {e.qualityTier && <span>· biz {e.qualityTier}</span>}
                      </div>
                      {em && <span className="mt-1 inline-block rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={{ color: em.color, background: em.color + '18' }}>{em.label}</span>}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{board.note}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ——— Grading — every snapshotted call, scored against what actually happened ———
function GradingPanel({ enabled }: { enabled: boolean }) {
  const { tiers, labelRows, note, loading } = useGrading(enabled)
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <CheckCircle2 size={14} className="text-faint" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Grading — did our calls beat the index?</span>
        {loading && <RefreshCw size={12} className="animate-spin text-faint" />}
        <span className="ml-auto text-[11px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="border-t border-line p-4 pt-3">
          {tiers.length === 0 && <p className="text-[12px] text-muted">No graded calls yet — grades appear as snapshotted calls mature against the label store ({labelRows.toLocaleString('en-IN')} outcome rows so far).</p>}
          {tiers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] tabular-nums">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-faint">
                    <th className="py-1 pr-3 font-semibold">Tier called</th>
                    <th className="px-2 py-1 text-right font-semibold">Calls</th>
                    <th className="px-2 py-1 text-right font-semibold">Avg 20d</th>
                    <th className="px-2 py-1 text-right font-semibold">Avg 20d vs NIFTY</th>
                    <th className="px-2 py-1 text-right font-semibold">Beat index (20d)</th>
                    <th className="px-2 py-1 text-right font-semibold">Avg 60d vs NIFTY</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((t) => (
                    <tr key={t.tier} className="border-b border-line/60">
                      <td className="py-1.5 pr-3 font-semibold text-ink">{t.tier}</td>
                      <td className="px-2 py-1.5 text-right">{t.n}</td>
                      <td className={`px-2 py-1.5 text-right ${col(t.avgR20)}`}>{pct(t.avgR20)}</td>
                      <td className={`px-2 py-1.5 text-right font-bold ${col(t.avgX20)}`}>{pct(t.avgX20)}</td>
                      <td className="px-2 py-1.5 text-right">{t.hitX20 != null ? `${t.hitX20}%` : '—'}</td>
                      <td className={`px-2 py-1.5 text-right ${col(t.avgX60)}`}>{pct(t.avgX60)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{note}</p>
        </div>
      )}
    </div>
  )
}

function RegimeBadge({ enabled }: { enabled: boolean }) {
  const { regime } = useRegime(enabled)
  if (!enabled || !regime) return null
  const m = REGIME_META[regime.label]
  const Icon = m.icon
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5" style={{ borderColor: m.color + '44', background: m.bg }}>
      <Icon size={16} className="mt-0.5 shrink-0" style={{ color: m.color }} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[12.5px] font-bold" style={{ color: m.color }}>Market regime: {m.label}</span>
          {regime.cautionMult < 1 && <span className="rounded-full bg-surface/70 px-2 py-0.5 text-[10px] font-semibold text-muted">conviction ×{regime.cautionMult} · dips ×{regime.dipCautionMult}</span>}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{regime.note}</p>
      </div>
    </div>
  )
}

function CalibrationPanel({ enabled }: { enabled: boolean }) {
  const { data, loading } = useCalibration(enabled)
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  const dips = data?.bands.filter((b) => b.dir === 'dip') ?? []
  const pops = data?.bands.filter((b) => b.dir === 'pop') ?? []
  const horizons = [...new Set((data?.bands ?? []).map((b) => b.horizon))].sort((a, b) => a - b)
  const rowsFor = (dir: 'dip' | 'pop') => [...new Set((dir === 'dip' ? dips : pops).map((b) => b.band))]
  const cell = (band: string, h: number) => data?.bands.find((b) => b.band === band && b.horizon === h)

  const Section = ({ title, dir }: { title: string; dir: 'dip' | 'pop' }) => (
    <div className="mt-2">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-faint">
              <th className="py-1 pr-3 font-semibold">1-day move</th>
              {horizons.map((h) => <th key={h} className="px-2 py-1 text-right font-semibold">{h}d: P(up) · med</th>)}
            </tr>
          </thead>
          <tbody>
            {rowsFor(dir).map((band) => (
              <tr key={band} className="border-b border-line/60 last:border-0">
                <td className="py-1.5 pr-3 font-medium text-strong">{band}</td>
                {horizons.map((h) => {
                  const s = cell(band, h)
                  if (!s) return <td key={h} className="px-2 py-1.5 text-right text-faint">—</td>
                  return (
                    <td key={h} className="px-2 py-1.5 text-right font-mono">
                      <span className={s.positivePct >= 50 ? 'text-up' : 'text-down'}>{s.positivePct}%</span>
                      <span className="text-faint"> · </span>
                      <span className={s.median >= 0 ? 'text-up' : 'text-down'}>{s.median > 0 ? '+' : ''}{s.median}%</span>
                      <span className="block text-[9px] text-faint">CI {s.ciLow}–{s.ciHigh} · n={s.n.toLocaleString()}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div className="card mt-4 p-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <div className="flex items-center gap-2">
          <Radar size={15} className="text-[#2186c4]" />
          <h3 className="text-[13.5px] font-bold text-ink">Setup calibration — universe-wide backtest</h3>
          {data && <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-faint">{data.symbols} names · {data.instances.toLocaleString()} setups</span>}
        </div>
        <ChevronDown size={16} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2">
          {loading && <p className="py-4 text-[12px] text-faint">Backtesting the universe (first run computes; then cached)…</p>}
          {!loading && data && data.bands.length > 0 && (
            <>
              <Section title="After a one-day drop (dip-buy)" dir="dip" />
              <Section title="After a one-day pop (momentum)" dir="pop" />
              <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{data.note}</p>
            </>
          )}
          {!loading && (!data || data.bands.length === 0) && <p className="py-3 text-[12px] text-muted">Not enough deep history to backtest yet — run a scan to build history.</p>}
        </div>
      )}
    </div>
  )
}

/** A compact watch-name row (used in the theme view for names not setting up today). */
function ThemeRow({ f, active, onSelect }: { f: WatchFlag; active: boolean; onSelect: (s: string) => void }) {
  return (
    <button onClick={() => onSelect(f.symbol)} className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors hover:bg-panel ${active ? 'border-[#7a5cff] bg-accent-soft' : 'border-line'}`}>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-bold text-ink">{f.name ?? f.symbol}</span>
          {f.sharpMove && <span className="rounded bg-down-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-down">sharp</span>}
        </span>
        <span className="block truncate text-[10.5px] text-faint">{f.tags.slice(0, 3).join(' · ') || '—'}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className={`block font-mono text-[12px] ${col(f.move1d)}`}>{pct(f.move1d)}</span>
        <span className="block font-mono text-[10px] text-faint">dd {pct(f.drawdown52w)}</span>
      </span>
    </button>
  )
}

function OpportunityBoard({ enabled, sel, onSelect, watchFlags }: { enabled: boolean; sel: string | null; onSelect: (s: string) => void; watchFlags: WatchFlag[] }) {
  const { token } = useAuth()
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [theme, setTheme] = useState<string | null>(null)
  const { board, scanning, reload } = useBoard(enabled, range)
  const rescan = async () => { await startScan(token); setRange('today'); setTimeout(reload, 1500) }

  const oppBySym = new Map((board?.opportunities ?? []).map((o) => [o.symbol, o]))
  // When a theme is picked: show EVERY name in that theme (from the watchlist), with the
  // ones that are also today's setups shown as full cards. Otherwise: today's ranked board.
  const themeFlags = theme ? watchFlags.filter((f) => themesOf(f.tags).includes(theme)).slice().sort((a, b) => (oppBySym.has(b.symbol) ? 1 : 0) - (oppBySym.has(a.symbol) ? 1 : 0) || (a.drawdown52w ?? 0) - (b.drawdown52w ?? 0)) : []
  const opps = board?.opportunities ?? []

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Radar size={15} className="text-[#7a5cff]" />
          <span className="text-[12px] font-bold uppercase tracking-[0.12em] text-muted">{range === 'week' ? 'Best setups this week' : 'Top opportunities today'}</span>
          {board && <span className="text-[11px] text-faint">· scanned {board.scanned} names · {timeAgo(board.asOf)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-panel p-0.5 text-[11px] font-semibold">
            <button onClick={() => setRange('today')} className={`rounded-md px-2.5 py-1 ${range === 'today' ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>Today</button>
            <button onClick={() => setRange('week')} className={`rounded-md px-2.5 py-1 ${range === 'week' ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`}>This week</button>
          </div>
          <button onClick={rescan} disabled={scanning} className="inline-flex items-center gap-1.5 rounded-lg bg-inkfill px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-50">
            {scanning ? <><RefreshCw size={12} className="animate-spin" /> Scanning…</> : <><RefreshCw size={12} /> Rescan</>}
          </button>
        </div>
      </div>

      {/* Theme filter — pick a sector to see EVERY name in it (banks / renewables / energy). */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-[11px]">
        <span className="font-bold uppercase tracking-wide text-faint">Theme</span>
        <button onClick={() => setTheme(null)} className={`rounded-full px-2.5 py-0.5 font-semibold ${!theme ? 'bg-inkfill text-white' : 'bg-panel text-muted hover:text-ink'}`}>All</button>
        {THEME_CHIPS.map((t) => (
          <button key={t.key} onClick={() => setTheme(theme === t.key ? null : t.key)} className={`rounded-full px-2.5 py-0.5 font-semibold ${theme === t.key ? 'bg-inkfill text-white' : 'bg-panel text-muted hover:text-ink'}`}>{t.label}</button>
        ))}
        {theme && <span className="text-faint">· {themeFlags.length} {theme} names ({themeFlags.filter((f) => oppBySym.has(f.symbol)).length} setting up today)</span>}
      </div>

      {/* TODAY'S BUYS — the explicit answer to "what do I buy today": constructive+ names
          with no red flag and a positive measured edge, best expectancy first. */}
      {(board?.buys ?? []).length > 0 && (
        <div className="border-b border-line px-4 py-2.5" style={{ background: '#f2faf5' }}>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#157a55' }}>
            <TrendingUp size={12} /> Today’s buys
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(board!.buys ?? []).map((b) => (
              <button key={b.symbol} onClick={() => onSelect(b.symbol)} className="group flex items-center gap-2 rounded-lg border border-[#1d9d6f44] bg-surface px-2.5 py-1.5 text-left hover:bg-up-soft">
                <span className="text-[12px] font-bold text-ink">{b.symbol}</span>
                {b.expectancy ? (
                  <span className="text-[10.5px] text-muted">
                    EV <b style={{ color: '#1d9d6f' }}>{b.expectancy.evPer100 >= 0 ? '+' : ''}{b.expectancy.evPer100}%</b> / ~{b.expectancy.horizon}d · {b.expectancy.winRate}% win · {b.expectancy.size}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-muted">{b.tier === 'high-conviction' ? 'high conviction' : 'leans buy'} · setup {b.score}</span>
                )}
                {(b.daysStudied ?? 1) >= 2 && (b.scoreDelta ?? 0) > 0 && <span className="rounded bg-up-soft px-1 py-0.5 text-[9px] font-bold text-up" title={`Studied ${b.daysStudied} days running; score up ${b.scoreDelta} vs the previous study`}>improving</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {board && (board.risers.length > 0 || board.fallers.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-[11px]">
          <span className="font-bold uppercase tracking-wide text-faint">Movers</span>
          {board.risers.slice(0, 6).map((m) => <button key={m.symbol} onClick={() => onSelect(m.symbol)} className="rounded-md bg-up-soft px-1.5 py-0.5 font-mono text-up hover:underline" title={m.name ?? m.symbol}>{m.symbol} +{m.move1d}%</button>)}
          {board.fallers.slice(0, 6).map((m) => <button key={m.symbol} onClick={() => onSelect(m.symbol)} className="rounded-md bg-down-soft px-1.5 py-0.5 font-mono text-down hover:underline" title={m.name ?? m.symbol}>{m.symbol} {m.move1d}%</button>)}
        </div>
      )}

      <div className="p-3">
        {!board && !scanning && <p className="p-3 text-[12.5px] italic text-faint">No scan yet — hit <b>Rescan</b> to study the universe and rank today’s best setups.</p>}
        {!board && scanning && <p className="flex items-center gap-2 p-3 text-[12.5px] italic text-faint"><RefreshCw size={13} className="animate-spin" /> Scanning the universe — studying prices, base rates, news, filings &amp; earnings… (a couple of minutes)</p>}

        {/* THEME view: every name in the sector (setups as full cards, the rest as quick rows). */}
        {theme ? (
          themeFlags.length === 0 ? (
            <p className="p-3 text-[12.5px] italic text-faint">No {theme} names on the watchlist.</p>
          ) : (
            <>
              <p className="mb-2 px-1 text-[11px] text-faint">Every {theme} name on your watch — click any to see its verdict, factors, base rate &amp; chart. Names setting up today are shown as full cards.</p>
              <div className="grid gap-2 md:grid-cols-2">
                {themeFlags.map((f) => {
                  const o = oppBySym.get(f.symbol)
                  return o ? <OppCard key={f.symbol} o={o} active={sel === f.symbol} onSelect={onSelect} /> : <ThemeRow key={f.symbol} f={f} active={sel === f.symbol} onSelect={onSelect} />
                })}
              </div>
            </>
          )
        ) : (
          <>
            {board && opps.length === 0 && <p className="p-3 text-[12.5px] italic text-faint">No standout setups in the latest scan.</p>}
            {board && opps.length > 0 && (
              <div className="grid gap-2 md:grid-cols-2">
                {opps.slice(0, 12).map((o) => <OppCard key={o.symbol} o={o} active={sel === o.symbol} onSelect={onSelect} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function OppCard({ o, active, onSelect }: { o: Opportunity; active: boolean; onSelect: (s: string) => void }) {
  const t = TIER_META[o.tier]
  return (
    <button onClick={() => onSelect(o.symbol)} className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-panel ${active ? 'border-[#7a5cff] bg-accent-soft' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-inkfill text-[10px] font-bold text-white">{o.rank}</span>
        <span className="truncate text-[13px] font-bold text-ink">{o.name ?? o.symbol}</span>
        <span className="font-mono text-[10px] text-faint">{o.symbol}</span>
        {o.daysSeen != null && o.daysSeen > 1 && <span className="ml-auto shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold text-[#7a5cff]" title={`Appeared in ${o.daysSeen} of this week's scans`}>×{o.daysSeen}</span>}
        <span className={`${o.daysSeen != null && o.daysSeen > 1 ? '' : 'ml-auto'} shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase`} style={{ color: TYPE_CHIP[o.type]?.c ?? '#1d9d6f', background: TYPE_CHIP[o.type]?.bg ?? '#e7f8f1' }}>{TYPE_CHIP[o.type]?.label ?? o.type}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-[11.5px]">
        <span className="font-semibold" style={{ color: t.color }}>{o.verdict.replace(/ — .*/, '')}</span>
        <span className="text-faint">· setup {o.score}</span>
        {(o.daysStudied ?? 1) >= 2 && o.scoreDelta != null && (
          <span className={o.scoreDelta > 0 ? 'text-up' : o.scoreDelta < 0 ? 'text-down' : 'text-faint'} title={`Studied ${o.daysStudied} days running; score ${o.scoreDelta >= 0 ? 'up' : 'down'} ${Math.abs(o.scoreDelta)} vs the previous study`}>
            · {o.scoreDelta > 0 ? '↗' : o.scoreDelta < 0 ? '↘' : '→'} d{o.daysStudied}
          </span>
        )}
        {o.qualityTier && <span style={{ color: QTIER[o.qualityTier]?.c ?? '#8a8f99' }}>· biz {o.qualityScore}{o.qualityAvoid ? ' ⚠' : ''}</span>}
        {o.move1d != null && <span className={col(o.move1d)}>· {o.move1d >= 0 ? '+' : ''}{o.move1d}%</span>}
        {o.expectancy && <span className="text-faint" title={`Comparable setups returned ${o.expectancy.evPer100}% on average over ~${o.expectancy.horizon} trading days (won ${o.expectancy.winRate}% of the time)`}>· EV {o.expectancy.evPer100 >= 0 ? '+' : ''}{o.expectancy.evPer100}%</span>}
      </div>
      <span className="text-[11.5px] leading-snug text-muted">{o.reasons[0]?.text ?? ''}</span>
      {(o.themes ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(o.themes ?? []).map((th) => <span key={th} className="rounded bg-panel px-1.5 py-0.5 text-[9px] font-semibold capitalize text-muted">{th}</span>)}
        </div>
      )}
    </button>
  )
}

const TYPE_CHIP: Record<string, { label: string; c: string; bg: string }> = {
  dip: { label: 'Dip-buy', c: '#1d9d6f', bg: '#e7f8f1' },
  rise: { label: 'Riser', c: '#2186c4', bg: '#e8f3fb' },
  trend: { label: 'Steady trend', c: '#6a1b9a', bg: '#f3e8fb' },
  watch: { label: 'Watch', c: '#8a8f99', bg: '#f0f1f3' },
}

const THEME_CHIPS = [{ key: 'banks', label: 'Banks' }, { key: 'renewables', label: 'Renewables' }, { key: 'energy', label: 'Energy' }]
/** Map a name's tags → the headline themes (mirrors the server's themesFromTags). */
function themesOf(tags: string[]): string[] {
  const t = new Set((tags ?? []).map((x) => x.toLowerCase()))
  const out: string[] = []
  if (t.has('bank') || t.has('financials')) out.push('banks')
  if (t.has('renewables') || t.has('solar') || t.has('wind')) out.push('renewables')
  if (t.has('energy') || t.has('oilgas') || t.has('utility')) out.push('energy')
  return out
}

function WatchlistPanel({ flags, loading, sel, onSelect, onReload }: {
  flags: WatchFlag[]; loading: boolean; sel: string | null; onSelect: (s: string) => void; onReload: () => void
}) {
  const [theme, setTheme] = useState<string | null>(null)
  const shown = theme ? flags.filter((f) => themesOf(f.tags).includes(theme)) : flags
  return (
    // self-start so the grid doesn't stretch the panel to the (taller) signal-detail column
    // and leave white space below the list; sticky + viewport-height so the list scrolls fully.
    <div className="self-start rounded-2xl border border-line bg-surface shadow-sm lg:sticky lg:top-4">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Watchlist · {shown.length}{theme ? ` ${theme}` : ''}</span>
        <button onClick={onReload} className="text-faint hover:text-strong" title="Refresh"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {/* Theme filter — browse ALL bank / renewable / energy names (not just today's movers). */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-[10.5px]">
        <button onClick={() => setTheme(null)} className={`rounded-full px-2 py-0.5 font-semibold ${!theme ? 'bg-inkfill text-white' : 'bg-panel text-muted hover:text-ink'}`}>All</button>
        {THEME_CHIPS.map((t) => (
          <button key={t.key} onClick={() => setTheme(theme === t.key ? null : t.key)} className={`rounded-full px-2 py-0.5 font-semibold ${theme === t.key ? 'bg-inkfill text-white' : 'bg-panel text-muted hover:text-ink'}`}>{t.label}</button>
        ))}
      </div>
      <div className="max-h-[calc(100vh-11rem)] divide-y divide-line overflow-auto">
        {loading && flags.length === 0 && <p className="p-4 text-[12px] italic text-faint">Scanning…</p>}
        {shown.map((f) => (
          <button key={f.symbol} onClick={() => onSelect(f.symbol)} className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-panel ${sel === f.symbol ? 'bg-accent-soft' : ''}`}>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-ink">{f.symbol}</span>
                {f.sharpMove && <span className="rounded bg-down-soft px-1.5 py-0.5 text-[9px] font-bold uppercase text-down">sharp</span>}
                {!f.deep && <span className="rounded bg-panel px-1.5 py-0.5 text-[9px] font-bold uppercase text-faint" title="deep history not backfilled">shallow</span>}
              </span>
              <span className="block truncate text-[10.5px] text-faint">{f.tags.slice(0, 3).join(' · ') || '—'}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className={`block font-mono text-[12px] ${col(f.move1d)}`}>{pct(f.move1d)}</span>
              <span className="block font-mono text-[10px] text-faint">dd {pct(f.drawdown52w)}</span>
            </span>
          </button>
        ))}
        {!loading && flags.length === 0 && <p className="p-4 text-[12px] italic text-faint">No watchlist yet — run <code>npm run guidance:seed</code>.</p>}
        {!loading && flags.length > 0 && shown.length === 0 && <p className="p-4 text-[12px] italic text-faint">No {theme} names on the watchlist.</p>}
      </div>
    </div>
  )
}

const TONE_META: Record<Signal['readout']['tone'], { color: string; bg: string }> = {
  buy: { color: '#1d9d6f', bg: '#e7f8f1' },
  'lean-buy': { color: '#2186c4', bg: '#e8f3fb' },
  wait: { color: '#8a7322', bg: '#fdfaf0' },
  avoid: { color: '#c43a3a', bg: '#fdecec' },
}

function GuidanceChart({ symbol }: { symbol: string }) {
  const { candles, loading } = useGuidanceHistory(symbol)
  if (loading && candles.length === 0) return <div className="card p-4 text-[12px] italic text-faint">Loading price history…</div>
  if (candles.length < 5) return null
  return (
    <div className="card p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1">
        <span className="text-[12px] font-bold uppercase tracking-wide text-muted">Price history</span>
        <span className="text-[11px] text-faint">· {candles.length} sessions · {candles[0].date} → {candles[candles.length - 1].date}</span>
      </div>
      <TradingChart data={candles} symbol={symbol} height={300} />
    </div>
  )
}

function SignalDetail({ sig, symbol }: { sig: Signal; symbol: string }) {
  const r = sig.readout
  const tm = TONE_META[r.tone]
  const t = TIER_META[sig.tier]
  // ★ into the private investment watchlist + jump to the mock-order ticket.
  const stars = useStars(true)
  const starred = stars.has(sig.symbol)
  return (
    <div className="space-y-4">
      {/* ——— PLAIN-ENGLISH VERDICT (the hero) ——— */}
      <div className="overflow-hidden rounded-2xl border shadow-sm" style={{ borderColor: tm.color + '55' }}>
        <div className="px-4 py-4" style={{ background: tm.bg }}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[18px] font-bold text-ink">{sig.name ?? sig.symbol}</h2>
                <span className="font-mono text-[11px] text-faint">{sig.symbol}</span>
                <button
                  onClick={() => stars.toggle(sig.symbol)}
                  title={starred ? 'Remove from my private watchlist' : 'Star — add to my private investment watchlist'}
                  className="rounded-md p-0.5 transition hover:scale-110"
                >
                  <Star size={16} className="text-[#c9a03a]" fill={starred ? 'currentColor' : 'none'} />
                </button>
                <Link
                  to={`/portfolio?buy=${encodeURIComponent(sig.symbol)}`}
                  className="rounded-md border border-line bg-surface/70 px-2 py-0.5 text-[10.5px] font-bold text-strong transition hover:border-[#1d9d6f] hover:text-[#1d9d6f]"
                >
                  Invest (mock)
                </Link>
                {sig.price != null && <span className="text-[12px] text-muted">₹{sig.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>}
              </div>
              <div className="mt-1 text-[20px] font-bold leading-tight" style={{ color: tm.color }}>{r.verdict}</div>
            </div>
            <span className="rounded-lg bg-surface/70 px-2.5 py-1 text-[11px] font-semibold" style={{ color: tm.color }}>conviction {sig.score}/100</span>
          </div>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-strong">{r.bottomLine}</p>
        </div>

        <div className="space-y-3 bg-surface px-4 py-4">
          {/* reasons in plain English */}
          <div className="space-y-1.5">
            {r.reasons.map((rr, i) => <ReasonRow key={i} r={rr} />)}
          </div>

          {/* the odds, in plain words */}
          <div className="flex items-start gap-2 rounded-xl bg-panel px-3 py-2.5 text-[12.5px] leading-relaxed text-muted">
            <Activity size={15} className="mt-0.5 shrink-0 text-faint" />
            <span>{r.headline}</span>
          </div>

          {/* #5: expectancy — the odds as a decision: EV per ₹100, win rate, size */}
          {sig.expectancy && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-3 py-2.5 text-[12px]" style={{ background: sig.expectancy.evPer100 > 0 && sig.expectancy.size !== 'none' ? '#f2faf5' : '#f7f7f8' }}>
              <span className="font-bold uppercase tracking-wide text-[10.5px] text-faint">If you buy today</span>
              <span className="text-strong">₹100 → <b style={{ color: sig.expectancy.evPer100 >= 0 ? '#1d9d6f' : '#c43a3a' }}>₹{(100 + sig.expectancy.evPer100).toFixed(1)}</b> avg in ~{sig.expectancy.horizon} sessions</span>
              <span className="text-muted">won {sig.expectancy.winRate}% of {sig.expectancy.n} comparables{sig.expectancy.lowConfidence ? ' (thin sample)' : ''}</span>
              <span className="text-muted">typical win {sig.expectancy.typicalWin >= 0 ? '+' : ''}{sig.expectancy.typicalWin}% · typical laggard {sig.expectancy.typicalLoss}% · worst {sig.expectancy.worst}%</span>
              <span className="font-semibold" style={{ color: sig.expectancy.size === 'none' ? '#c43a3a' : '#157a55' }} title={sig.expectancy.sizeNote}>size: {sig.expectancy.size}</span>
            </div>
          )}

          {sig.watch?.sectorThesis && <p className="text-[11.5px] italic text-faint">Why it’s watched: {sig.watch.sectorThesis}</p>}
          {!sig.deep && <p className="text-[11px] italic text-faint">{sig.note}</p>}
        </div>
      </div>

      {/* "why this can go up" — each claim with the number/source that verifies it */}
      {r.bullCase && r.bullCase.points.length > 0 && (
        <div className="overflow-hidden rounded-2xl border shadow-sm" style={{ borderColor: '#1d9d6f55' }}>
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: '#e7f8f1' }}>
            <TrendingUp size={15} style={{ color: '#1d9d6f' }} />
            <span className="text-[13.5px] font-bold" style={{ color: '#157a55' }}>{r.bullCase.heading}</span>
          </div>
          <div className="space-y-2.5 bg-surface px-4 py-3.5">
            {r.bullCase.points.map((p, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white" style={{ background: '#1d9d6f' }}>{i + 1}</span>
                <div>
                  <p className="text-[13px] leading-relaxed text-strong">{p.text}</p>
                  <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-relaxed text-faint">
                    <CheckCircle2 size={11} className="mt-0.5 shrink-0" style={{ color: '#1d9d6f' }} />
                    <span><span className="font-semibold text-muted">Verified by:</span> {p.proof}</span>
                  </p>
                </div>
              </div>
            ))}
            {r.bullCase.note && (
              <p className="flex items-start gap-1.5 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-muted">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" style={{ color: '#8a7322' }} />
                {r.bullCase.note}
              </p>
            )}
          </div>
        </div>
      )}

      {/* price chart — multi-year candles for the selected name */}
      <GuidanceChart symbol={symbol} />

      {/* business quality — a SEPARATE axis from the price/timing verdict above */}
      <QualityPanel q={sig.quality} />

      {/* the actual events behind the verdict */}
      <DevelopmentsPanel sig={sig} />

      {/* deeper LLM read */}
      <AnalystPanel symbol={symbol} />

      {/* ——— THE NUMBERS (collapsible, for those who want them) ——— */}
      <NumbersSection sig={sig} tierLabel={t.label} tierColor={t.color} tierBg={t.bg} />
    </div>
  )
}

const REASON_META: Record<Reason['tone'], { color: string; Icon: typeof TrendingUp }> = {
  up: { color: '#1d9d6f', Icon: TrendingUp },
  down: { color: '#2186c4', Icon: ArrowDownCircle },
  value: { color: '#1d9d6f', Icon: Coins },
  warn: { color: '#c43a3a', Icon: AlertTriangle },
  info: { color: '#8a8f99', Icon: Info },
}

const QTIER: Record<string, { c: string; bg: string; label: string }> = {
  excellent: { c: '#1d9d6f', bg: '#e7f8f1', label: 'Excellent business' },
  good: { c: '#2186c4', bg: '#e8f3fb', label: 'Good business' },
  fair: { c: '#8a7322', bg: '#fdfaf0', label: 'Average business' },
  weak: { c: '#c43a3a', bg: '#fdecec', label: 'Weak business' },
}

function QualityPanel({ q }: { q: Fundamentals | null }) {
  if (!q) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Business quality</div>
        <p className="text-[12px] italic text-faint">Fundamentals not available for this name.</p>
      </div>
    )
  }
  const t = QTIER[q.qualityTier] ?? QTIER.fair
  const metric = (label: string, val: string) => (
    <span className="rounded-lg bg-panel px-2 py-1 text-[11.5px] text-muted"><b className="text-muted">{label}</b> {val}</span>
  )
  const block = (title: string, b: { score: number; points: string[] }, positive: boolean) => (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-faint">
        {title}<span style={{ color: b.score >= 0 ? GAIN : LOSS }}>{b.score >= 0 ? '+' : ''}{b.score.toFixed(2)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {b.points.map((p, i) => (
          <span key={i} className="rounded-md px-1.5 py-0.5 text-[11px]" style={{ background: positive ? '#f1f6f3' : '#fdf2f2', color: positive ? '#3a3a3a' : '#c43a3a' }}>{p}</span>
        ))}
      </div>
    </div>
  )
  return (
    <div className="rounded-2xl border shadow-sm" style={{ borderColor: t.c + '44' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl px-4 py-3" style={{ background: t.bg }}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Business quality</span>
          <span className="rounded-lg bg-surface/70 px-2 py-0.5 text-[12px] font-bold" style={{ color: t.c }}>{t.label} · {q.qualityScore}/100</span>
          {q.isBank && <span className="rounded bg-surface/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted">bank</span>}
        </div>
        <span className="text-[10.5px] text-muted">separate from the entry-timing verdict above{q.asOf ? ` · as of ${q.asOf.slice(0, 10)}` : ''}</span>
      </div>
      <div className="space-y-3 bg-surface p-4">
        {q.risk.forceAvoid && (
          <div className="flex items-start gap-2 rounded-lg bg-down-soft px-3 py-2 text-[11.5px] text-down">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" /><span><b>Fundamentals say avoid:</b> {q.risk.points.join('; ')}.</span>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {q.profitCagr3y != null && metric('Profit 3Y', `${q.profitCagr3y >= 0 ? '+' : ''}${q.profitCagr3y}%/yr`)}
          {q.salesCagr3y != null && metric('Sales 3Y', `${q.salesCagr3y >= 0 ? '+' : ''}${q.salesCagr3y}%/yr`)}
          {q.roe3y != null && metric('ROE 3Y', `${q.roe3y}%`)}
          {!q.isBank && q.debtToEquity != null && metric('D/E', `${q.debtToEquity}`)}
          {!q.isBank && q.interestCoverage != null && metric('Int cover', `${q.interestCoverage}x`)}
          {q.cfoToOp != null && metric('CFO/OP', `${q.cfoToOp}`)}
          {q.pe != null && metric('P/E', `${q.pe}`)}
          {q.peg != null && metric('PEG', `${q.peg}`)}
          {q.pb != null && metric('P/B', `${q.pb}`)}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {block('Growth', q.quality, true)}
          {block('Financial health', q.health, true)}
          {block('Valuation', q.valuation, true)}
          {block('Risk', q.risk, false)}
        </div>
        {q.note && <p className="text-[10.5px] italic text-faint">{q.note}</p>}
      </div>
    </div>
  )
}

function DevelopmentsPanel({ sig }: { sig: Signal }) {
  const devs = [...sig.developments.filings, ...sig.developments.news].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
  const r = sig.results
  const dirMeta = { improving: { c: '#1d9d6f', t: 'improving' }, deteriorating: { c: '#c43a3a', t: 'weakening' }, mixed: { c: '#8a7322', t: 'mixed' } }
  const dm = r?.direction ? dirMeta[r.direction] : null
  const toneColor = (t: string) => (t === 'supportive' ? '#1d9d6f' : t === 'concerning' ? '#c43a3a' : '#9ca1aa')
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Recent developments & earnings</div>

      {/* earnings trend strip */}
      {r && dm ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-panel px-3 py-2 text-[12px]">
          <span className="font-semibold" style={{ color: dm.c }}>Earnings {dm.t}</span>
          <span className="text-muted">Profit <b className={col(r.profitTtmGrowth)}>{r.profitTtmGrowth != null ? `${r.profitTtmGrowth >= 0 ? '+' : ''}${r.profitTtmGrowth}%` : '—'}</b> TTM</span>
          <span className="text-muted">Sales <b className={col(r.salesTtmGrowth)}>{r.salesTtmGrowth != null ? `${r.salesTtmGrowth >= 0 ? '+' : ''}${r.salesTtmGrowth}%` : '—'}</b> TTM</span>
          <span className="text-muted">Latest Q profit <b className={col(r.profitLatestYoY)}>{r.profitLatestYoY != null ? `${r.profitLatestYoY >= 0 ? '+' : ''}${r.profitLatestYoY}%` : '—'}</b> YoY</span>
          <span className="text-[10.5px] text-faint">as-of {r.asOfQuarter ?? '—'} · screener.in</span>
        </div>
      ) : (
        <p className="mb-3 text-[11.5px] italic text-faint">Quarterly results not available for this name.</p>
      )}

      {/* the actual filings + news */}
      {devs.length === 0 ? (
        <p className="text-[12px] italic text-faint">No recent filings or tagged news in the store for this name yet.</p>
      ) : (
        <div className="space-y-1.5">
          {devs.map((d, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: toneColor(d.tone) }} />
              <span className="w-12 shrink-0 text-[10.5px] text-faint">{d.date.slice(5)}</span>
              <span className="min-w-0">
                <span className="text-strong">{d.summary || d.title}</span>
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-faint">
                  {d.kind === 'filing' ? d.category : d.category}{d.materiality === 'high' ? ' · high' : ''}
                  {d.link && <> · <a href={d.link} target="_blank" rel="noreferrer" className="text-[#2186c4] hover:underline">source</a></>}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The fact line under a reason: the measured number + dates + source the point was laid
// out from. When the fact carries a URL (filings/news), it renders as a source link.
function FactLine({ fact }: { fact: string }) {
  const m = fact.match(/https?:\/\/\S+/)
  const body = m ? fact.slice(0, m.index).replace(/\s*—\s*$/, '') : fact
  return (
    <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
      {body}
      {m && (
        <>
          {body ? ' — ' : ''}
          <a href={m[0]} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-muted">source</a>
        </>
      )}
    </span>
  )
}

function ReasonRow({ r }: { r: Reason }) {
  const m = REASON_META[r.tone]
  const Icon = m.Icon
  return (
    <div className="flex items-start gap-2.5 text-[13px] leading-relaxed">
      <Icon size={15} className="mt-0.5 shrink-0" style={{ color: m.color }} />
      <span className="text-strong">
        {r.text}
        {r.fact && <FactLine fact={r.fact} />}
      </span>
    </div>
  )
}

function NumbersSection({ sig, tierLabel, tierColor, tierBg }: { sig: Signal; tierLabel: string; tierColor: string; tierBg: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronDown size={15} className={`text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">The numbers behind it</span>
        <span className="ml-2 rounded-md px-2 py-0.5 text-[10px] font-bold" style={{ color: tierColor, background: tierBg }}>{tierLabel}</span>
        <span className="ml-auto text-[11px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line p-4">
          {sig.cappedByRisk && (
            <div className="flex items-start gap-2 rounded-lg bg-down-soft px-3 py-2 text-[11.5px] text-down">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" /><span><b>Capped by a thesis-breaker:</b> {sig.breaks.join('; ')}. Conviction held down regardless of the other factors.</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {sig.groups.map((g) => (
              <span key={g.group} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px]">
                <span className="text-muted">{GROUP_LABEL[g.group]}</span>
                <b style={{ color: g.score >= 0 ? GAIN : LOSS }}>{g.score >= 0 ? '+' : ''}{g.score.toFixed(2)}</b>
              </span>
            ))}
          </div>
          <BaseRatePanel base={sig.baserate} />
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Full factor stack ({sig.factors.length})</div>
            <div className="space-y-3">
              {sig.groups.map((g) => (
                <div key={g.group}>
                  <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-faint">{GROUP_LABEL[g.group]}</div>
                  <div className="space-y-1">{g.factors.map((f) => <FactorRow key={f.code} f={f} />)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FactorRow({ f }: { f: Factor }) {
  const w = Math.min(100, Math.abs(f.contribution) * 60)
  return (
    <div className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-[12px] ${f.breaksThesis ? 'bg-down-soft' : ''}`}>
      <span className="w-48 shrink-0 truncate text-muted" title={f.note}>
        {f.breaksThesis && <ShieldAlert size={11} className="mr-1 inline text-down" />}{f.label}
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-strong">{f.display}</span>
      <span className="relative h-2 flex-1 rounded-full bg-panel">
        <span className="absolute top-0 h-2 rounded-full" style={{ left: f.contribution >= 0 ? '50%' : `calc(50% - ${w / 2}%)`, width: `${w / 2}%`, background: f.contribution >= 0 ? GAIN : LOSS }} />
        <span className="absolute left-1/2 top-[-2px] h-3 w-px bg-panel" />
      </span>
      <span className="w-24 shrink-0 truncate text-right text-[10px] text-faint" title={`${f.source}${f.asOf ? ' · ' + f.asOf : ''}`}>{f.source}</span>
    </div>
  )
}

function BaseRatePanel({ base }: { base: Signal['baserate'] }) {
  const [which, setWhich] = useState<'cohort' | 'self'>(base.cohort && base.cohort.n >= base.self.n ? 'cohort' : 'self')
  const br: BaseRate = which === 'cohort' && base.cohort ? base.cohort : base.self
  const up = br.direction === 'up'
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-faint" />
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Historical base rate</span>
          {br.lowConfidence && <span className="rounded bg-warn-soft px-2 py-0.5 text-[10px] font-bold uppercase text-[#b08a2e]">low confidence · n={br.n}</span>}
        </div>
        {base.cohort && (
          <div className="flex gap-1 text-[11px]">
            <button onClick={() => setWhich('self')} className={`rounded-md px-2 py-0.5 ${which === 'self' ? 'bg-inkfill text-white' : 'text-muted hover:bg-panel'}`}>{base.self.cohortLabel}</button>
            <button onClick={() => setWhich('cohort')} className={`rounded-md px-2 py-0.5 ${which === 'cohort' ? 'bg-inkfill text-white' : 'text-muted hover:bg-panel'}`}>{base.cohort.cohortLabel}</button>
          </div>
        )}
      </div>
      <p className="mb-2 text-[11.5px] text-muted">
        When <b>{br.cohortLabel}</b> had a <b>{br.setup}</b> in the past (<b>n={br.n}</b> comparable setups), here’s what actually happened next — {up ? 'buying the pop' : 'buying the dip'}:
        {br.regimeState && (
          <span
            className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${br.regimeConditioned ? 'bg-up-soft text-up' : 'bg-panel text-faint'}`}
            title={br.regimeConditioned ? `Only setups that occurred with NIFTY ${br.regimeState} its 200-DMA (today's state) are counted` : `Too few setups in today's market state (NIFTY ${br.regimeState} its 200-DMA) — all-regimes odds shown`}
          >
            {br.regimeConditioned ? 'regime-matched' : 'all regimes'}
          </span>
        )}
      </p>
      {br.activeSetup === false ? (
        <p className="text-[12.5px] italic text-faint">{br.note || 'No active setup — today’s move is within the normal daily range, so there’s no dip/pop to base-rate.'}</p>
      ) : br.n === 0 ? (
        <p className="text-[12.5px] italic text-faint">No comparable historical setups in the available history{br.note ? ` — ${br.note}` : ''}.</p>
      ) : (
        <>
          <table className="w-full text-[12px]">
            <thead><tr className="border-b border-line text-left text-[9.5px] uppercase tracking-[0.1em] text-faint">
              <th className="pb-1.5 font-bold">Horizon</th><th className="pb-1.5 text-right font-bold">Median</th><th className="pb-1.5 text-right font-bold">P25 / P75</th><th className="pb-1.5 text-right font-bold">Worst</th><th className="pb-1.5 text-right font-bold">% positive</th><th className="pb-1.5 text-right font-bold" title={up ? 'closed still above the pre-pop base level' : 'closed back at/above the pre-drop level'}>{up ? 'Above pre-pop' : 'Back to pre-drop'}</th><th className="pb-1.5 text-right font-bold">n</th>
            </tr></thead>
            <tbody>
              {br.horizons.map((h) => (
                <tr key={h.horizon} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-muted">{h.horizon}d</td>
                  <td className={`py-1.5 text-right font-mono ${col(h.median)}`}>{pct(h.median)}</td>
                  <td className="py-1.5 text-right font-mono text-faint">{pct(h.p25)} / {pct(h.p75)}</td>
                  <td className="py-1.5 text-right font-mono text-down">{pct(h.worst)}</td>
                  <td className="py-1.5 text-right font-mono text-muted">{h.positivePct}%</td>
                  <td className="py-1.5 text-right font-mono text-muted">{h.recoveredTerminalPct}%</td>
                  <td className={`py-1.5 text-right font-mono ${h.lowConfidence ? 'text-[#b08a2e]' : 'text-faint'}`} title={h.lowConfidence ? 'thin sample at this horizon — treat loosely' : undefined}>{h.n}{h.lowConfidence ? '*' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span>{up ? 'Faded back to the pre-pop base within window' : 'Touched pre-drop level within window'}: <b className="text-strong">{br.recoveredTouchPct ?? '—'}%</b></span>
            {br.worstCase && <span className="text-down">Worst single outcome: <b>{pct(br.worstCase.forwardReturn)}</b> ({br.worstCase.symbol}, {br.worstCase.date})</span>}
          </div>
          {br.misses.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <span className="text-[10.5px] font-bold uppercase tracking-wide text-faint">The misses ({br.misses.length} shown)</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {br.misses.map((m, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-down-soft px-1.5 py-0.5 text-[10.5px] text-down"><TrendingDown size={10} /> {m.symbol} {pct(m.forwardReturn)} · {m.date}</span>
                ))}
              </div>
            </div>
          )}
          {br.note && <p className="mt-2 text-[10.5px] italic text-faint">{br.note}</p>}
          <p className="mt-1 text-[10.5px] italic text-faint">
            {br.pitCoverage?.conditioned
              ? `Point-in-time universe applied from ${br.pitCoverage.from}: instances only count if the name was in the index on the setup date, so the survivorship caveat is lifted over that span.`
              : 'Survivor-conditioned: measured over names still listed today; delisted/suspended outcomes are absent, so these odds read optimistically.'}
            {br.horizons.some((h) => h.lowConfidence) ? ' “*” marks thin-sample horizons.' : ''}
          </p>
        </>
      )}
    </div>
  )
}

function AnalystPanel({ symbol }: { symbol: string }) {
  const { brief, loading, run } = useAnalyst(symbol)
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2"><Sparkles size={14} className="text-[#7a5cff]" /><span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Analyst brief</span></div>
        {!brief && <button onClick={run} disabled={loading} className="rounded-lg bg-inkfill px-3 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50">{loading ? 'Thinking…' : 'Generate'}</button>}
      </div>
      {!brief && !loading && <p className="text-[12px] italic text-faint">Grounded bull / bear / what-breaks-it brief — generated from the factor context above, never a forward guarantee.</p>}
      {loading && <p className="flex items-center gap-2 text-[12px] italic text-faint"><RefreshCw size={13} className="animate-spin" /> Reasoning over the factor stack…</p>}
      {brief && (
        <div className="space-y-2.5 text-[12.5px] leading-relaxed">
          {brief.stance && <div className="rounded-lg bg-panel px-3 py-2"><b className="text-ink">Stance:</b> <span className="text-muted">{brief.stance}</span></div>}
          {brief.bull && <p><TrendingUp size={13} className="mr-1 inline text-up" /><b className="text-up">Bull:</b> <span className="text-muted">{brief.bull}</span></p>}
          {brief.bear && <p><TrendingDown size={13} className="mr-1 inline text-down" /><b className="text-down">Bear:</b> <span className="text-muted">{brief.bear}</span></p>}
          {brief.whatBreaks && <p><ShieldAlert size={13} className="mr-1 inline text-[#b08a2e]" /><b className="text-[#b08a2e]">What breaks it:</b> <span className="text-muted">{brief.whatBreaks}</span></p>}
          {brief.model && <p className="text-[10px] text-faint">{brief.provider} · {brief.model}</p>}
        </div>
      )}
    </div>
  )
}
