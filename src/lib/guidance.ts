// Client for the PRIVATE Investment Guidance desk (/api/guidance/*).
// Every call carries the owner's Supabase bearer token; the server 404s for anyone
// else, so access is decided server-side. `useGuidanceAccess` probes /status — a 200
// means "show the section", a 404 means "stay hidden".
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './auth'
import { refreshAccessToken } from './token'

// ——— shapes (mirror server/src/guidance/*) ———
export type FactorGroup = 'price' | 'relative' | 'catalyst' | 'news' | 'fundamental' | 'risk'

export interface Factor {
  code: string
  label: string
  group: FactorGroup
  value: number | string | null
  display: string
  score: number
  weight: number
  contribution: number
  source: string
  asOf: string | null
  note?: string
  breaksThesis?: boolean
}

export interface GroupSummary {
  group: FactorGroup
  score: number
  weight: number
  factors: Factor[]
}

export interface HorizonStat {
  horizon: number
  n: number
  mean?: number // average forward return — the expectancy input (#5)
  median: number
  p25: number
  p75: number
  worst: number
  best: number
  positivePct: number
  recoveredTerminalPct: number
  lowConfidence?: boolean // per-horizon thin-sample flag (M-G2)
}

export interface BaseRate {
  setup: string
  direction?: 'down' | 'up'
  band: [number, number]
  cohortLabel: string
  symbols: string[]
  n: number
  horizons: HorizonStat[]
  recoveredTouchPct: number | null
  worstCase: { forwardReturn: number; horizon: number; date: string; symbol: string } | null
  misses: { forwardReturn: number; date: string; symbol: string }[]
  lowConfidence: boolean
  activeSetup?: boolean // false on a quiet day — no dip/pop setup (M-G1)
  regimeState?: 'above' | 'below' | null // today's NIFTY-vs-200DMA state the sample was matched to (9.6)
  regimeConditioned?: boolean // false = matched sample too thin, all-regimes odds shown
  pitCoverage?: { from: string; conditioned: boolean } | null // 9.5: point-in-time universe applied (survivorship caveat lifted over the covered span)
  matching?: 'knn' | 'band' // #3: knn = k past setups most similar to today's; band = severity-band fallback
  k?: number | null
  note: string
}

/** #5: odds → decision aid ("what ₹100 in this setup returned on average"). */
export interface Expectancy {
  horizon: number
  evPer100: number
  winRate: number
  typicalWin: number
  typicalLoss: number
  worst: number
  n: number
  lowConfidence: boolean
  size: 'none' | 'small' | 'medium' | 'full'
  sizeNote: string
  source: 'self' | 'cohort'
}

export type ReasonTone = 'up' | 'down' | 'value' | 'warn' | 'info'
export interface Reason {
  tone: ReasonTone
  text: string
  code: string
  fact?: string // the factual basis: measured number + dates + source (URL where one exists)
}
export interface Readout {
  verdict: string
  tone: 'buy' | 'lean-buy' | 'wait' | 'avoid'
  headline: string
  bottomLine: string
  reasons: Reason[]
  bullCase?: BullCase | null // "why this can go up" — each claim with its verifying proof
}

export interface BullPoint {
  text: string
  proof: string
}
export interface BullCase {
  heading: string
  points: BullPoint[]
  note: string | null
}

export type DevTone = 'supportive' | 'concerning' | 'neutral'
export interface Development {
  date: string
  kind: 'filing' | 'news'
  category: string
  title: string
  summary: string | null
  materiality: string | null
  tone: DevTone
  link: string | null
}
export interface Developments {
  filings: Development[]
  news: Development[]
  positives: Development[]
  negatives: Development[]
}
export interface ResultsTrend {
  asOfQuarter: string | null
  salesLatestYoY: number | null
  profitLatestYoY: number | null
  salesTtmGrowth: number | null
  profitTtmGrowth: number | null
  direction: 'improving' | 'deteriorating' | 'mixed' | null
  quarters: { q: string; sales: number | null; profit: number | null }[]
  source: 'screener.in'
  note: string
}

export interface FundBlock {
  score: number
  points: string[]
}
export interface Fundamentals {
  symbol: string
  isBank: boolean
  asOf?: string // when the fundamentals were last scraped (staleness surfaced in the UI)
  salesCagr3y: number | null
  profitCagr3y: number | null
  profitCagr5y: number | null
  roe3y: number | null
  roceLatest: number | null
  marginTrend: string | null
  debtToEquity: number | null
  interestCoverage: number | null
  cfoToOp: number | null
  pe: number | null
  peg: number | null
  pb: number | null
  divYield: number | null
  quality: FundBlock
  health: FundBlock
  valuation: FundBlock
  risk: FundBlock & { forceAvoid: boolean }
  qualityScore: number
  qualityTier: 'excellent' | 'good' | 'fair' | 'weak'
  note: string
}

export interface Signal {
  symbol: string
  name: string | null
  asOf: string
  dataDate: string | null
  price: number | null
  score: number
  normalized: number
  tier: 'high-conviction' | 'constructive' | 'neutral' | 'avoid'
  cappedByRisk: boolean
  breaks: string[]
  factors: Factor[]
  groups: GroupSummary[]
  baserate: { self: BaseRate; cohort: BaseRate | null }
  readout: Readout
  developments: Developments
  results: ResultsTrend | null
  quality: Fundamentals | null
  watch: { symbol: string; sectorThesis: string | null; tags: string[]; active: boolean; addedAt: string } | null
  deep: boolean
  note: string
  regime?: Regime
  expectancy?: Expectancy | null
}

export interface Mover {
  symbol: string
  name: string | null
  move1d: number
}
export interface Opportunity {
  rank: number
  symbol: string
  name: string | null
  type: 'dip' | 'rise' | 'trend' | 'watch'
  score: number
  tier: 'high-conviction' | 'constructive' | 'neutral' | 'avoid'
  verdict: string
  reasons: { tone: string; text: string }[]
  odds: string
  price: number | null
  move1d: number | null
  move5d: number | null
  cappedByRisk: boolean
  deep: boolean
  qualityScore: number | null
  qualityTier: string | null
  qualityAvoid: boolean
  themes?: string[] // banks / renewables / energy (owner focus)
  daysSeen?: number // "this week" view only: how many of the week's scans it appeared in
  daysStudied?: number // conviction accrual: distinct days studied in the last week
  scoreDelta?: number | null // today's score − the previous study's score
  expectancy?: { evPer100: number; horizon: number; winRate: number; size: string } | null
}
export interface Board {
  asOf: string
  scanned: number
  deepScored: number
  buys?: Opportunity[] // the explicit daily buy list (latest scan)
  opportunities: Opportunity[]
  risers: Mover[]
  fallers: Mover[]
  note: string
}

export interface WatchFlag {
  symbol: string
  name: string | null
  thesis: string | null
  tags: string[]
  price: number | null
  dataDate: string | null
  move1d: number | null
  drawdown52w: number | null
  rsi14: number | null
  sharpMove: boolean
  deep: boolean
}

export interface AnalystBrief {
  bull: string
  bear: string
  whatBreaks: string
  stance: string
  model: string | null
  provider: string | null
}

function headers(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Module-scoped `fetch` that shadows the global for THIS FILE ONLY, so every
 *  /api/guidance call below routes through it without changing 29 call sites.
 *
 *  Why it exists: the desk answers 404 for "you have no access" (the section stays
 *  hidden) and 401 for "your session lapsed". Access tokens die after ~1h, and a tab
 *  left open on My Investments used to poll every 60s with the dead token forever —
 *  rendering an empty page until a manual reload. On a 401 we renew once and replay. */
async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await globalThis.fetch(input, init)
  if (res.status !== 401) return res
  const fresh = await refreshAccessToken()
  if (!fresh) return res // signed out, or the refresh token itself lapsed
  const h = new Headers(init.headers)
  h.set('Authorization', `Bearer ${fresh}`)
  return globalThis.fetch(input, { ...init, headers: h })
}

/** Probe whether the owner may see the section (200 → yes, 404 → hidden).
 *  M-G7: only probe for a LOGGED-IN session. Anonymous visitors can never be owners, so
 *  firing `/api/guidance/status` for them needlessly advertises the endpoint's existence
 *  (and its 404-vs-200 fingerprint) to every unauthenticated page load. No token → hidden,
 *  no request. */
export function useGuidanceAccess(): { enabled: boolean; admin: boolean; loading: boolean } {
  const { token } = useAuth()
  const [state, setState] = useState({ enabled: false, admin: false, loading: true })
  useEffect(() => {
    if (!token) { setState({ enabled: false, admin: false, loading: false }); return }
    let off = false
    setState((s) => ({ ...s, loading: true }))
    fetch('/api/guidance/status', { headers: headers(token), signal: AbortSignal.timeout(8000) })
      .then(async (r) => {
        const d = r.ok ? await r.json().catch(() => ({})) : {}
        if (!off) setState({ enabled: r.ok, admin: Boolean(d.admin), loading: false })
      })
      .catch(() => { if (!off) setState({ enabled: false, admin: false, loading: false }) })
    return () => { off = true }
  }, [token])
  return state
}

// ——— access management (admin only) ———

export interface AccessUser {
  userEmail: string
  addedBy: string
  addedAt: string
}

export interface PendingUser {
  userEmail: string
  firstSeen: string
  lastSeen: string
}

export function useAccessUsers(admin: boolean): { admins: string[]; users: AccessUser[]; pending: PendingUser[]; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [admins, setAdmins] = useState<string[]>([])
  const [users, setUsers] = useState<AccessUser[]>([])
  const [pending, setPending] = useState<PendingUser[]>([])
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!admin) return
    setLoading(true)
    fetch('/api/guidance/users', { headers: headers(token), signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? r.json() : { admins: [], users: [], pending: [] }))
      .then((d) => { setAdmins(d.admins ?? []); setUsers(d.users ?? []); setPending(d.pending ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [admin, token])
  useEffect(reload, [reload])
  return { admins, users, pending, loading, reload }
}

export async function grantAccess(token: string | null, email: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/guidance/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ email }),
  })
  const d = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: d.error ?? 'failed' }
}

export async function revokeAccess(token: string | null, email: string): Promise<void> {
  await fetch(`/api/guidance/users/${encodeURIComponent(email)}`, { method: 'DELETE', headers: headers(token) }).catch(() => {})
}

export function useBoard(enabled: boolean, range: 'today' | 'week' = 'today'): { board: Board | null; scanning: boolean; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [board, setBoard] = useState<Board | null>(null)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    const url = range === 'week' ? '/api/guidance/opportunities/week' : '/api/guidance/opportunities'
    fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? r.json() : { board: null, scanning: false }))
      .then((d) => { setBoard(d.board); setScanning(d.scanning); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token, range])
  useEffect(reload, [reload])
  // Poll while a scan is running so the board refreshes when it finishes.
  useEffect(() => {
    if (!scanning) return
    const id = setInterval(reload, 12000)
    return () => clearInterval(id)
  }, [scanning, reload])
  return { board, scanning, loading, reload }
}

export async function startScan(token: string | null): Promise<void> {
  await fetch('/api/guidance/scan', { method: 'POST', headers: headers(token) }).catch(() => {})
}

export function useWatchlist(enabled: boolean): { flags: WatchFlag[]; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [flags, setFlags] = useState<WatchFlag[]>([])
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    fetch('/api/guidance/watchlist', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : { flags: [] }))
      .then((d) => { setFlags(d.flags ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token])
  useEffect(reload, [reload])
  return { flags, loading, reload }
}

export interface TierStat { tier: string; horizon: number; n: number; hitRate: number; avgReturn: number; medianReturn: number; worst: number }
export interface TrackRecord { tiers: TierStat[]; totalCalls: number; evaluated: number; since: string | null; horizons: number[]; note: string }

/** Realized forward outcomes of the desk's own past calls (accumulates daily). */
export function useTrackRecord(enabled: boolean): { data: TrackRecord | null; loading: boolean } {
  const { token } = useAuth()
  const [data, setData] = useState<TrackRecord | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/track-record', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setData(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { data, loading }
}

export interface BandCalib { band: string; dir: 'dip' | 'pop'; horizon: number; n: number; positivePct: number; ciLow: number; ciHigh: number; median: number; avg: number; worst: number }
export interface SetupCalibration { bands: BandCalib[]; symbols: number; instances: number; computedAt: string; note: string }

/** Universe-wide backtest: empirical odds after each move band (deterministic). */
export function useCalibration(enabled: boolean): { data: SetupCalibration | null; loading: boolean } {
  const { token } = useAuth()
  const [data, setData] = useState<SetupCalibration | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/calibration', { headers: headers(token), signal: AbortSignal.timeout(60000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setData(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { data, loading }
}

// ——— 5-day winning streaks (closed higher every session, from the daily price record) ———
export interface StreakEntry {
  symbol: string
  name: string | null
  totalPct: number
  dailyPct: number[] // per-session gain, oldest → newest
  price: number
  from: string
  to: string
  avgTurnoverCr: number
}
export interface Streaks {
  asOf: string | null
  days: number
  entries: StreakEntry[]
  scanned: number
  qualified: number
  note: string
}

/** Top names that closed higher every single session for the last 5 trading days. */
export function useStreaks(enabled: boolean): { streaks: Streaks | null; loading: boolean } {
  const { token } = useAuth()
  const [streaks, setStreaks] = useState<Streaks | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/streaks', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setStreaks(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { streaks, loading }
}

export interface Regime {
  label: 'risk-on' | 'neutral' | 'risk-off'
  trend: 'above' | 'below'
  vsMA200Pct: number
  vol: 'calm' | 'normal' | 'stressed'
  volAnnualPct: number
  drawdownPct: number
  cautionMult: number
  dipCautionMult: number
  note: string
  asOf: string | null
}

/** Current market regime — drives the caution the desk applies (dips hardest in risk-off). */
export function useRegime(enabled: boolean): { regime: Regime | null; loading: boolean } {
  const { token } = useAuth()
  const [regime, setRegime] = useState<Regime | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/regime', { headers: headers(token), signal: AbortSignal.timeout(20000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setRegime(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { regime, loading }
}

export interface GCandle { date: string; o: number; h: number; l: number; c: number; v: number }

/** Deep price-history candles for the selected name's chart. */
export function useGuidanceHistory(symbol: string | null): { candles: GCandle[]; loading: boolean } {
  const { token } = useAuth()
  const [candles, setCandles] = useState<GCandle[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!symbol) { setCandles([]); return }
    let off = false
    setLoading(true)
    fetch(`/api/guidance/history/${encodeURIComponent(symbol)}`, { headers: headers(token), signal: AbortSignal.timeout(20000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setCandles(d?.candles ?? []); setLoading(false) } })
      .catch(() => { if (!off) { setCandles([]); setLoading(false) } })
    return () => { off = true }
  }, [symbol, token])
  return { candles, loading }
}

export function useSignal(symbol: string | null): { sig: Signal | null; loading: boolean } {
  const { token } = useAuth()
  const [sig, setSig] = useState<Signal | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!symbol) { setSig(null); return }
    let off = false
    setLoading(true)
    setSig(null)
    fetch(`/api/guidance/signal/${encodeURIComponent(symbol)}`, { headers: headers(token), signal: AbortSignal.timeout(90000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setSig(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [symbol, token])
  return { sig, loading }
}

/** Analyst brief is lazy + slow (LLM) — call run() to fetch it. */
export function useAnalyst(symbol: string | null): { brief: AnalystBrief | null; loading: boolean; run: () => void } {
  const { token } = useAuth()
  const [brief, setBrief] = useState<AnalystBrief | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { setBrief(null) }, [symbol])
  const run = useCallback(() => {
    if (!symbol) return
    setLoading(true)
    fetch(`/api/guidance/analyst/${encodeURIComponent(symbol)}`, { headers: headers(token), signal: AbortSignal.timeout(90000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setBrief(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [symbol, token])
  return { brief, loading, run }
}

// ——————————————————————————————————————————————————————————————
// Paper trading (mock money) — private starred watchlist + broker-style mock portfolio.
// ——————————————————————————————————————————————————————————————

export interface StarView {
  symbol: string
  name: string | null
  starredAt: string
  price: number | null
  priceDate: string | null
  move1d: number | null
}

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
  ltpLive: boolean
  value: number | null
  pnl: number | null
  pnlPct: number | null
  dayChangePct: number | null
  vsNiftyPct: number | null
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
  alphaPct: number | null
}

export interface Portfolio {
  account: {
    startingCapital: number
    cash: number
    invested: number
    currentValue: number
    portfolioValue: number
    unrealizedPnl: number
    realizedPnl: number
    dayPnl: number
    totalReturnPct: number
  }
  open: OpenPositionView[]
  closed: ClosedPositionView[]
  note: string
}

/** The private starred list, with a toggle. `has(symbol)` powers the star buttons. */
export function useStars(enabled: boolean): { stars: StarView[]; has: (s: string) => boolean; toggle: (s: string) => Promise<void>; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [stars, setStars] = useState<StarView[]>([])
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    fetch('/api/guidance/stars', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : { stars: [] }))
      .then((d) => { setStars(d.stars ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token])
  useEffect(reload, [reload])
  const has = useCallback((s: string) => stars.some((x) => x.symbol === s.toUpperCase()), [stars])
  const toggle = useCallback(async (s: string) => {
    const sym = s.toUpperCase()
    const starred = stars.some((x) => x.symbol === sym)
    // optimistic flip so the star feels instant
    setStars((cur) => (starred ? cur.filter((x) => x.symbol !== sym) : [{ symbol: sym, name: null, starredAt: new Date().toISOString(), price: null, priceDate: null, move1d: null }, ...cur]))
    await fetch(`/api/guidance/stars/${encodeURIComponent(sym)}`, { method: starred ? 'DELETE' : 'POST', headers: headers(token) }).catch(() => {})
    reload()
  }, [stars, token, reload])
  return { stars, has, toggle, loading, reload }
}

export function usePortfolio(enabled: boolean): { pf: Portfolio | null; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [pf, setPf] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    fetch('/api/guidance/portfolio', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setPf(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token])
  useEffect(reload, [reload])
  // The marks are ~15-min-delayed live quotes with a 60s server cache — poll every
  // minute so P&L actually moves with the market while the page is open.
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(reload, 60_000)
    return () => clearInterval(id)
  }, [enabled, reload])
  return { pf, loading, reload }
}

// ——— momentum board (6m/3m relative strength, skip-month, earnings-confirmed) ———

export interface MomentumEntry {
  rank: number
  symbol: string
  name: string | null
  price: number
  m6: number
  m3: number
  score: number
  avgTurnoverCr: number
  earnings: 'improving' | 'deteriorating' | 'mixed' | null
  qualityTier: string | null
  fact: string
}
export interface MomentumBoard {
  asOf: string | null
  entries: MomentumEntry[]
  scanned: number
  eligible: number
  note: string
}

export function useMomentum(enabled: boolean): { board: MomentumBoard | null; loading: boolean } {
  const { token } = useAuth()
  const [board, setBoard] = useState<MomentumBoard | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/momentum', { headers: headers(token), signal: AbortSignal.timeout(120000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) { setBoard(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { board, loading }
}

// ——— grading: the desk's snapshotted calls scored against measured outcomes ———

export interface TierGrade {
  tier: string
  n: number
  avgR20: number | null
  avgX20: number | null
  hitX20: number | null
  avgX60: number | null
  hitX60: number | null
  since: string | null
}

export function useGrading(enabled: boolean): { tiers: TierGrade[]; labelRows: number; note: string; loading: boolean } {
  const { token } = useAuth()
  const [data, setData] = useState<{ tiers: TierGrade[]; labelRows: number; note: string }>({ tiers: [], labelRows: 0, note: '' })
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let off = false
    setLoading(true)
    fetch('/api/guidance/grading', { headers: headers(token), signal: AbortSignal.timeout(60000) })
      .then((r) => (r.ok ? r.json() : { tiers: [], labelRows: 0, note: '' }))
      .then((d) => { if (!off) { setData(d); setLoading(false) } })
      .catch(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [enabled, token])
  return { ...data, loading }
}

// ——— sell-advisor notifications ———

export interface Notification {
  id: number
  positionId: number | null
  symbol: string
  kind: string
  severity: 'info' | 'warn' | 'urgent'
  title: string
  body: string
  fact: string | null
  createdAt: string
  readAt: string | null
}

export function useNotifications(enabled: boolean): { items: Notification[]; unread: number; loading: boolean; reload: () => void; markRead: (id?: number) => Promise<void> } {
  const { token } = useAuth()
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    fetch('/api/guidance/notifications', { headers: headers(token), signal: AbortSignal.timeout(20000) })
      .then((r) => (r.ok ? r.json() : { items: [], unread: 0 }))
      .then((d) => { setItems(d.items ?? []); setUnread(d.unread ?? 0); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token])
  useEffect(reload, [reload])
  const markRead = useCallback(async (id?: number) => {
    await fetch('/api/guidance/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(token) },
      body: JSON.stringify(id != null ? { id } : {}),
    }).catch(() => {})
    reload()
  }, [token, reload])
  return { items, unread, loading, reload, markRead }
}

// ——— trade logs: per-position daily P&L since entry ———

export interface PositionLogPoint {
  date: string
  close: number
  dayPnl: number
  cumPnl: number
  live?: boolean
}

export interface PositionLog {
  id: number
  symbol: string
  name: string | null
  qty: number
  entryPrice: number
  entryDate: string
  todayPnl: number | null
  todayPct: number | null
  totalPnl: number | null
  series: PositionLogPoint[]
}

export function usePortfolioLogs(enabled: boolean): { logs: PositionLog[]; note: string; loading: boolean; reload: () => void } {
  const { token } = useAuth()
  const [logs, setLogs] = useState<PositionLog[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    fetch('/api/guidance/portfolio/logs', { headers: headers(token), signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : { positions: [], note: '' }))
      .then((d) => { setLogs(d.positions ?? []); setNote(d.note ?? ''); setLoading(false) })
      .catch(() => setLoading(false))
  }, [enabled, token])
  useEffect(reload, [reload])
  return { logs, note, loading, reload }
}

export async function placeOrder(
  token: string | null,
  order: { symbol: string; qty: number; price?: number; stopLoss?: number; target?: number; notes?: string },
): Promise<{ ok: boolean; error?: string; fillPrice?: number; fillDate?: string }> {
  const r = await fetch('/api/guidance/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify(order),
  })
  const d = await r.json().catch(() => ({}))
  return r.ok ? { ok: true, ...d } : { ok: false, error: d.error ?? 'order failed' }
}

export async function closePtPosition(token: string | null, id: number, opts: { qty?: number; price?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/api/guidance/positions/${id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify(opts),
  })
  const d = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: d.error ?? 'close failed' }
}

export async function updatePtStops(token: string | null, id: number, stopLoss: number | null, target: number | null): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/api/guidance/positions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ stopLoss, target }),
  })
  const d = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: d.error ?? 'update failed' }
}

export async function resetPtAccount(token: string | null, capital?: number): Promise<void> {
  await fetch('/api/guidance/portfolio/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ capital }),
  }).catch(() => {})
}

export async function addWatch(token: string | null, symbol: string, thesis: string, tags: string[]): Promise<void> {
  await fetch('/api/guidance/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ symbol, thesis, tags }),
  })
}

export async function removeWatch(token: string | null, symbol: string): Promise<void> {
  await fetch(`/api/guidance/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE', headers: headers(token) })
}

export async function getConfig(token: string | null): Promise<Record<string, unknown>> {
  const r = await fetch('/api/guidance/config', { headers: headers(token) })
  return r.ok ? r.json() : {}
}

export async function setConfig(token: string | null, key: string, value: unknown): Promise<void> {
  await fetch('/api/guidance/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ key, value }),
  })
}
