// Frontend API client for the Bharat Market Pro server.
// Pattern: every fetcher resolves to the SAME types as src/data/* and falls back
// to the bundled mock dataset if the API is unreachable — the UI always works.

import { useEffect, useState } from 'react'
import { useQuery, invalidate } from './query'
import { authHeader } from './token'
import { news as mockNews, type NewsItem } from '../data/news'

export type DataSource = 'live' | 'mock'

interface NewsResponse {
  source: DataSource
  fetchedAt?: string
  feeds?: string[]
  news: NewsItem[]
}

export async function fetchNews(): Promise<NewsResponse> {
  try {
    const res = await fetch('/api/news', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as NewsResponse
    if (!Array.isArray(data.news) || data.news.length === 0) throw new Error('empty payload')
    return data
  } catch {
    return { source: 'mock', news: mockNews }
  }
}

// ——— Listed-insurer KPIs (REAL, sourced from the DB — replaces the sample set) ———

export interface InsurerKpi {
  symbol: string
  type: 'Life' | 'General' | 'Health'
  vnbMarginPct: number | null
  solvencyRatio: number | null
  persistency13mPct: number | null
  combinedRatioPct: number | null
  apeGrowthPct: number | null
  embeddedValueCr: number | null
  marketSharePct: number | null
  period: string
  sourceUrl: string | null
}

async function fetchInsurerKpis(): Promise<InsurerKpi[]> {
  try {
    const res = await fetch('/api/insurer-kpis', { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { kpis: InsurerKpi[] }
    return Array.isArray(data.kpis) ? data.kpis : []
  } catch {
    return []
  }
}

/** All listed-insurer KPIs; `bySymbol` picks the one for a company page. */
export function useInsurerKpis() {
  const { data } = useQuery('/api/insurer-kpis', fetchInsurerKpis, { ttl: 60 * 60_000 })
  const kpis = data ?? []
  return { kpis, bySymbol: (symbol: string) => kpis.find((k) => k.symbol === symbol) }
}

// ——— Real EOD candles (NSE bhavcopy via server) with mock fallback ———

import type { Candle } from '../data/series'

interface CandlesResponse {
  source: 'real' | 'mock'
  candles: Candle[]
}

async function fetchCandles(path: string): Promise<CandlesResponse> {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as CandlesResponse
    if (data.source !== 'real' || !Array.isArray(data.candles) || data.candles.length === 0) throw new Error('no real data')
    return data
  } catch {
    return { source: 'mock', candles: [] }
  }
}

/**
 * Candles for an equity symbol or an index, with fallback.
 * `mockCandles` (the seeded series) renders instantly; real NSE EOD data replaces
 * it when the price store has rows for this instrument.
 */
export function useCandles(kind: 'equity' | 'index', key: string, mockCandles: Candle[]) {
  const path = key ? (kind === 'equity' ? `/api/prices/${encodeURIComponent(key)}` : `/api/index-prices/${encodeURIComponent(key)}`) : null
  // Per-URL cache: navigating Company→News→Company reuses the last EOD candles.
  const { data } = useQuery(path, () => fetchCandles(path as string), { ttl: 5 * 60_000 })
  if (data && data.source === 'real' && data.candles.length > 0) {
    return { candles: data.candles, source: 'live' as DataSource }
  }
  return { candles: mockCandles, source: 'mock' as DataSource }
}

// ——— Live NSE filings with AI digests ———

import { filings as mockFilings } from '../data/filings'
import { companyBySymbol } from '../data/companies'

export interface DeskFiling {
  id: string
  exchange: 'NSE' | 'BSE'
  symbol: string | null
  company: string
  category: string
  title: string
  filedAt: string
  link?: string
  aiSummary: string | null
  materiality: 'high' | 'medium' | 'low'
  ai: boolean
}

const mockDeskFilings: DeskFiling[] = mockFilings.map((f) => ({
  id: f.id,
  exchange: f.exchange,
  symbol: f.symbol,
  company: companyBySymbol.get(f.symbol)?.name ?? f.symbol,
  category: f.category,
  title: f.title,
  filedAt: f.filedAt,
  aiSummary: f.aiSummary,
  materiality: f.materiality,
  ai: false,
}))

interface FilingsResponse {
  source: DataSource
  llm?: { provider: string; model: string; available: boolean }
  filings: DeskFiling[]
}

async function fetchFilings(): Promise<FilingsResponse> {
  // AUDIT FIX (2026-07-14): unlike every other fetcher, this used to THROW on a network
  // error or empty feed, poisoning the cache entry with an error and no data. Now it
  // resolves to the mock fallback so the TTL throttles retries and the page shows a
  // clean "mock" source instead of an errored-but-invisible state.
  try {
    const res = await fetch('/api/filings', { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as FilingsResponse
    if (data.source !== 'live' || !data.filings?.length) throw new Error('no live filings')
    return data
  } catch {
    return { source: 'mock', filings: mockDeskFilings }
  }
}

// Single cache key: Dashboard + Filings both mount useFilings() and now share one
// request (previously a double /api/filings fetch on every dashboard visit).
export function useFilings() {
  const { data, loading } = useQuery('/api/filings', fetchFilings, { ttl: 5 * 60_000 })
  return {
    items: data?.filings ?? mockDeskFilings,
    source: (data ? 'live' : 'mock') as DataSource,
    llmReady: Boolean(data?.llm?.available),
    loading,
  }
}

// ——— Per-company feed: news / corporate actions / announcements / risks / desk note ———

export interface CompanyFeed {
  symbol: string
  name: string
  industry: string
  domain: string | null
  deskNote: { note: string; ai: boolean }
  news: { id: string; headline: string; source: string; publishedAt: string; sentiment: 'positive' | 'negative' | 'neutral'; sentimentScore: number; link?: string }[]
  corporateActions: { type: string; date: string; detail: string; source: string; link?: string }[]
  announcements: DeskFiling[]
  riskFlags: { severity: 'high' | 'medium' | 'low'; title: string; description: string; signal: string }[]
}

// Concurrency gate: RiskMonitor fans out one company-feed request per watchlist name,
// each up to 45s + several LLM calls server-side. Cap the client to a few in-flight so
// we don't hammer the backend (or trip provider bans). The cache still dedupes per symbol.
const FEED_CONCURRENCY = 3
let feedActive = 0
const feedQueue: (() => void)[] = []
function acquireFeedSlot(): Promise<void> {
  if (feedActive < FEED_CONCURRENCY) { feedActive++; return Promise.resolve() }
  return new Promise<void>((resolve) => feedQueue.push(resolve))
}
function releaseFeedSlot() {
  const next = feedQueue.shift()
  if (next) next() // hand the slot to the next waiter (active count unchanged)
  else feedActive--
}

async function fetchCompanyFeed(symbol: string): Promise<CompanyFeed | null> {
  await acquireFeedSlot()
  try {
    const r = await fetch(`/api/company-feed/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(45_000) })
    const d = r.ok ? await r.json() : null
    return d?.symbol ? (d as CompanyFeed) : null
  } finally {
    releaseFeedSlot()
  }
}

// Per-symbol cache — RiskMonitor fans out many of these; Company360 + RiskMonitor
// now dedupe a shared symbol, and the 45s feed survives navigation.
export function useCompanyFeed(symbol: string) {
  const { data, loading } = useQuery(
    symbol ? `/api/company-feed/${symbol}` : null,
    () => fetchCompanyFeed(symbol),
    { ttl: 5 * 60_000 },
  )
  return { feed: data ?? null, loading }
}

// ——— Company fact sheet (screener.in via server, cached daily) ———

export interface FactSheet {
  symbol: string
  source: string
  url: string
  asOf: string
  ratios: { label: string; value: string }[]
  about: string | null
  pros: string[]
  cons: string[]
  domain?: string | null
}

async function fetchFactSheet(symbol: string): Promise<FactSheet | null> {
  const r = await fetch(`/api/fact-sheet/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(25_000) })
  const d = r.ok ? await r.json() : null
  return d?.ratios ? (d as FactSheet) : null
}

export function useFactSheet(symbol: string) {
  const { data, loading } = useQuery(
    symbol ? `/api/fact-sheet/${symbol}` : null,
    () => fetchFactSheet(symbol),
    { ttl: 10 * 60_000 },
  )
  return { sheet: data ?? null, loading }
}

// ——— Price alerts (server-evaluated against live quotes) ———

export interface PriceAlert {
  id: number
  symbol: string
  condition: 'above' | 'below'
  price: number
  active: boolean
  createdAt: string
  triggeredAt: string | null
  triggerPrice: number | null
}

async function fetchAlerts(symbol?: string): Promise<{ active: PriceAlert[]; history: PriceAlert[] }> {
  const res = await fetch(`/api/alerts${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = (await res.json()) as { active: PriceAlert[]; history: PriceAlert[] }
  return { active: d.active ?? [], history: d.history ?? [] }
}

// Cache-backed + per-symbol keyed. Company360 and AlertPanel share one request for
// the same symbol; refresh() re-runs every mounted alerts query.
export function useAlerts(symbol?: string) {
  const key = `/api/alerts${symbol ? `?symbol=${symbol}` : ''}`
  const { data, loading } = useQuery(key, () => fetchAlerts(symbol), { ttl: 30_000 })
  const refresh = () => invalidate('/api/alerts')
  return { active: data?.active ?? [], history: data?.history ?? [], loading, refresh }
}

// Mutation result — callers surface `error` via a toast instead of failing silently.
export interface MutationResult { ok: boolean; error?: string }

export async function createPriceAlert(symbol: string, condition: 'above' | 'below', price: number): Promise<MutationResult> {
  try {
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ symbol, condition, price }),
    })
    if (res.status === 401) return { ok: false, error: 'Sign in to set alerts.' }
    if (!res.ok) return { ok: false, error: `Couldn't set the alert (HTTP ${res.status}).` }
    invalidate('/api/alerts')
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — the alert was not saved.' }
  }
}

export async function togglePriceAlert(id: number, activeState: boolean): Promise<MutationResult> {
  try {
    const res = await fetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ active: activeState }),
    })
    if (!res.ok) return { ok: false, error: `Couldn't update the alert (HTTP ${res.status}).` }
    invalidate('/api/alerts')
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — the alert was not updated.' }
  }
}

export async function deletePriceAlert(id: number): Promise<MutationResult> {
  try {
    const res = await fetch(`/api/alerts/${id}`, { method: 'DELETE', headers: authHeader() })
    if (!res.ok) return { ok: false, error: `Couldn't delete the alert (HTTP ${res.status}).` }
    invalidate('/api/alerts')
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — the alert was not deleted.' }
  }
}

// ——— AI research chat (server LLM → null means caller should use the rule engine) ———

export interface DeskAnswer {
  answer: string
  grounded: string[]
  model: string
}

export async function askDesk(
  messages: { role: 'user' | 'assistant'; content: string }[],
  opts?: { symbol?: string; webDive?: boolean },
): Promise<DeskAnswer | null> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, symbol: opts?.symbol, webDive: opts?.webDive }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { answer?: string; grounded?: string[]; model?: string }
    return data.answer ? { answer: data.answer, grounded: data.grounded ?? [], model: data.model ?? '' } : null
  } catch {
    return null
  }
}

// ——— 9.2 Agentic research desk (plan → tools → cited answer). null → caller falls
// back to askDesk (classic grounded chat), then the offline rule engine. ———

export interface AgentTraceLine {
  tool: string
  summary: string
}

export interface AgentAnswer extends DeskAnswer {
  toolTrace: AgentTraceLine[]
}

export async function askAgent(question: string, opts?: { symbol?: string }): Promise<AgentAnswer | null> {
  try {
    const res = await fetch('/api/research-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, symbol: opts?.symbol }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { answer?: string; grounded?: string[]; model?: string; toolTrace?: AgentTraceLine[] }
    return data.answer
      ? { answer: data.answer, grounded: data.grounded ?? [], model: data.model ?? '', toolTrace: data.toolTrace ?? [] }
      : null
  } catch {
    return null
  }
}

// ——— Real-time(ish) quotes (delayed, labeled) — refreshed every 60s ———

export interface LiveQuote {
  key: string
  price: number
  prevClose: number
  changePct: number
  marketTime: string | null
}

export function useQuotes(keys: string[]) {
  const [quotes, setQuotes] = useState<Map<string, LiveQuote>>(new Map())
  const joined = keys.filter(Boolean).join(',')

  useEffect(() => {
    if (!joined) return
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/quotes?keys=${encodeURIComponent(joined)}`, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return
        const data = (await res.json()) as { quotes: LiveQuote[] }
        if (!cancelled && data.quotes?.length) setQuotes(new Map(data.quotes.map((q) => [q.key, q])))
      } catch {
        /* keep last known */
      }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [joined])

  return quotes
}

// ——— NIFTY 500 universe (real EOD closes) ———

export interface UniverseRow {
  symbol: string
  name: string
  industry: string
  domain: string | null
  close: number | null
  prevClose: number | null
  changePct: number | null
}

async function fetchUniverse(): Promise<{ asOf: string | null; rows: UniverseRow[] }> {
  const res = await fetch('/api/universe', { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = (await res.json()) as { asOf: string | null; rows: UniverseRow[] }
  if (!d.rows?.length) throw new Error('empty universe')
  return d
}

// The universe is large and rarely changes intraday — cache it for 10 minutes so the
// many pages that read it (Header search, Dock, Dashboard, Companies…) share one fetch.
export function useUniverse() {
  const { data, loading } = useQuery('/api/universe', fetchUniverse, { ttl: 10 * 60_000 })
  return { asOf: data?.asOf ?? null, rows: data?.rows ?? [], loading }
}

/**
 * News with live→mock fallback. Starts on mock, upgrades to live when the API
 * answers, then keeps polling every 2 minutes for a near-realtime feed.
 */
export function useNews() {
  // Cache-backed; still polls every 2 minutes for a near-realtime feed, but a revisit
  // within the window shows cached news instantly instead of refetching.
  const { data, loading } = useQuery('/api/news', fetchNews, { ttl: 60_000, refetchInterval: 2 * 60 * 1000 })
  const live = data?.source === 'live'
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  // AUDIT FIX (2026-07-14): depend on `data` (a new object each successful poll) rather
  // than the server's `fetchedAt` string, which can be a fixed ingest timestamp — so the
  // "updated at" label actually advances on every 2-minute background refresh.
  useEffect(() => { if (live && data) setUpdatedAt(new Date()) }, [live, data])
  return {
    items: live && data ? data.news : mockNews,
    source: (live ? 'live' : 'mock') as DataSource,
    feeds: live ? data?.feeds ?? [] : [],
    updatedAt,
    loading,
  }
}
