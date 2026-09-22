// Frontend client for the ULIP Insurance Monitor API (/api/ulip/*).
// Data is from insurer public factsheets.
import { useEffect, useState } from 'react'
import { useQuery } from './query'
import { authHeader } from './token'

export interface FundFlag { code: string; severity: string; message: string }
export interface FreshnessMonth { month: string; parseStatus: string; funds: number; clean: number; suspicious: number; failed: number }
export interface InsurerFreshness { code: string; name: string; status: 'active' | 'parked'; latestStored: string | null; months: FreshnessMonth[] }
export interface InsurersResponse { latestMonth: string | null; defaultMonth?: string | null; months: string[]; insurers: InsurerFreshness[]; attribution: string }

export interface UlipFund {
  sfin: string; month: string; insurer: string; name: string; class: string | null; category: string | null
  nav: number | null; inception: string | null; benchmark: string | null; manager: string | null
  ytm: number | null; modifiedDuration: number | null; managedSummary: string | null
  aumTotal: number | null; aumUnit: string | null; aumTotalCr: number | null
  aumEquityCr: number | null; aumDebtCr: number | null; aumMmiCr: number | null
  status: string; confidence: number | null; flags: FundFlag[]; coverage?: Record<string, string>
}
export interface FundReturn { period: string; returnPct: number | null; benchmarkPct: number | null }
export interface FundAlloc { kind: string; label: string; weight: number | null; fuMin: number | null; fuMax: number | null }
export interface Holding { security: string; weightPct: number | null; normalizedSymbol: string | null; category: string | null; rawCategory: string | null; isin: string | null; rating: string | null; marketValue: number | null }
export interface FundSource { kind: string; url: string | null; rawPath: string; fetchedAt: string; parseStatus: string }
export interface SourceLink { type: 'pdf' | 'web'; href: string; page: number | null; label: string; fileName: string | null }
export interface FundDetail {
  month: string; fund: UlipFund; returns: FundReturn[]
  allocations: { asset: FundAlloc[]; sector: FundAlloc[]; fnu: FundAlloc[]; rating: FundAlloc[]; maturity: FundAlloc[] }
  holdings: Holding[]; sources: FundSource[]; sourceLink?: SourceLink
}
export interface Holder { insurer: string; insurerName: string | null; sfin: string; fundName: string; fundStatus: string; security: string; weightPct: number | null }
export interface SymbolOption { symbol: string; company: string | null; holders: number }
export interface CompareEntry { fund: UlipFund; returns: FundReturn[]; allocations: FundAlloc[] }

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch {
    return null
  }
}

export interface UlipChatMsg { role: 'user' | 'assistant'; content: string }
export interface UlipChatResult { answer: string; grounded: string[]; model: string; provider: string }

export interface RefreshState {
  status: 'running' | 'done' | 'error'
  insurer: string
  month: string
  startedAt: string
  finishedAt?: string
  stored?: number
  message?: string
}

/** Trigger a fresh fetch+extract for one insurer (by IRDAI code). Returns false if busy. */
export async function triggerUlipRefresh(insurer: string, month: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/ulip/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ insurer, month }), signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 409) return { ok: false, busy: true }
    if (res.status === 401) return { ok: false, error: 'not authorized — sign in as an admin' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function getRefreshStatus(): Promise<RefreshState | null> {
  const d = await getJSON<{ current: RefreshState | null }>('/api/ulip/refresh/status')
  return d?.current ?? null
}

/** Ask the Insurance Monitor assistant — grounded in factsheet data, optional web-dive. */
export async function fetchUlipChat(
  messages: UlipChatMsg[],
  opts: { month?: string | null; webDive?: boolean } = {},
): Promise<UlipChatResult | null> {
  try {
    const res = await fetch('/api/ulip/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, month: opts.month ?? undefined, webDive: Boolean(opts.webDive) }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return null
    return (await res.json()) as UlipChatResult
  } catch {
    return null
  }
}

export function useUlipInsurers() {
  const { data, loading } = useQuery('/api/ulip/insurers', () => getJSON<InsurersResponse>('/api/ulip/insurers'), { ttl: 5 * 60_000 })
  return { data: data ?? null, loading }
}

export function useUlipFunds(insurer: string | null, month: string | null, category: string | null, best = false) {
  const q = new URLSearchParams()
  if (month) q.set('month', month)
  if (insurer) q.set('insurer', insurer)
  if (category) q.set('category', category)
  if (best) q.set('best', '1')
  // Per-URL cache: FundsTab and TrendsTab both request the whole month — now one fetch.
  const key = month ? `/api/ulip/funds?${q}` : null
  const { data, loading } = useQuery(key, () => getJSON<{ funds: UlipFund[] }>(key as string), { ttl: 5 * 60_000 })
  return { funds: data?.funds ?? [], loading }
}

export function useUlipCategories(month: string | null) {
  const key = month ? `/api/ulip/categories?month=${month}` : null
  const { data } = useQuery(key, () => getJSON<{ categories: string[] }>(key as string), { ttl: 5 * 60_000 })
  return data?.categories ?? []
}

export function useUlipFund(sfin: string | null, month: string | null) {
  const key = sfin && month ? `/api/ulip/fund/${encodeURIComponent(sfin)}?month=${month}` : null
  const { data, loading } = useQuery(key, () => getJSON<FundDetail>(key as string), { ttl: 5 * 60_000 })
  return { detail: data ?? null, loading }
}

export function useConsolidatedSymbols(month: string | null) {
  const key = month ? `/api/ulip/consolidated/symbols?month=${month}` : null
  const { data } = useQuery(key, () => getJSON<{ symbols: SymbolOption[] }>(key as string), { ttl: 5 * 60_000 })
  return data?.symbols ?? []
}

export function useConsolidated(symbol: string | null, month: string | null) {
  const key = symbol && month ? `/api/ulip/consolidated?symbol=${encodeURIComponent(symbol)}&month=${month}` : null
  const { data, loading } = useQuery(key, () => getJSON<{ holders: Holder[] }>(key as string), { ttl: 5 * 60_000 })
  return { holders: data?.holders ?? [], loading }
}

export async function fetchCompare(sfins: string[], month: string): Promise<CompareEntry[]> {
  const d = await getJSON<{ funds: CompareEntry[] }>(`/api/ulip/compare?sfins=${sfins.map(encodeURIComponent).join(',')}&month=${month}`)
  return d?.funds ?? []
}

type QuarantineRow = { sfin: string; insurer: string; name: string; confidence: number | null; flags: FundFlag[] }
export function useQuarantine(month: string | null) {
  const key = month ? `/api/ulip/quarantine?month=${month}` : null
  const { data } = useQuery(key, () => getJSON<{ funds: QuarantineRow[] }>(key as string), { ttl: 5 * 60_000 })
  return data?.funds ?? []
}

// On-demand Excel export URLs (anchor downloads).
export const exportUrls = {
  company: (insurer: string, month: string) => `/api/ulip/export/company?insurer=${insurer}&month=${month}`,
  section: (category: string, month: string) => `/api/ulip/export/section?category=${encodeURIComponent(category)}&month=${month}`,
  comparative: (sfins: string[], month: string) => `/api/ulip/export/comparative?sfins=${sfins.map(encodeURIComponent).join(',')}&month=${month}`,
  consolidated: (month: string) => `/api/ulip/export/consolidated?month=${month}`,
}

// ——— Month-over-month ———
export interface MoMChange { security: string; prev: number | null; now: number | null; delta: number }
export interface FundMoM {
  sfin: string; month: string; prevMonth: string; hasPrev: boolean
  added: MoMChange[]; removed: MoMChange[]; increased: MoMChange[]; decreased: MoMChange[]; unchanged: number
}

// ——— Fund history (time-series) — powers the Trends tab ———
export interface HistoryAlloc { label: string; weight: number | null }
export interface HistoryPoint {
  month: string
  nav: number | null
  aumTotalCr: number | null
  aumEquityCr: number | null
  aumDebtCr: number | null
  status: string
  returns: FundReturn[]
  assetAlloc: HistoryAlloc[]
  sectorAlloc: HistoryAlloc[]
  holdings: Holding[]
}
export interface FundHistory {
  sfin: string
  name: string | null
  insurer: string | null
  benchmark: string | null
  mock: boolean
  points: HistoryPoint[]
}

export function useFundHistory(sfin: string | null) {
  const key = sfin ? `/api/ulip/fund/${encodeURIComponent(sfin)}/history` : null
  const { data, loading } = useQuery(key, () => getJSON<FundHistory>(key as string), { ttl: 5 * 60_000 })
  return { history: data ?? null, loading }
}

export function useFundMoM(sfin: string | null, month: string | null) {
  const key = sfin && month ? `/api/ulip/fund/${encodeURIComponent(sfin)}/mom?month=${month}` : null
  const { data } = useQuery(key, () => getJSON<FundMoM>(key as string), { ttl: 5 * 60_000 })
  return data ?? null
}

// ——— Admin: manual factsheet upload ———
// Automated fetching breaks whenever an insurer moves a URL or puts the document behind
// a WAF, so uploading the PDF by hand is the dependable path. It runs the same
// extract -> validate -> store pipeline, so an uploaded month is in no way second-class.

export interface UlipAdminInsurer { id: string; code: string; name: string; format: string; hasExtractor: boolean }
export interface UlipAdminStatus {
  admin: boolean
  /** Whether the offline (no-LLM) extractor is usable on this deployment. */
  deterministicExtractor?: boolean
  insurers?: UlipAdminInsurer[]
}

/** Whether the signed-in user may see the upload tools. Non-admins get `{admin:false}`. */
export function useUlipAdmin(): { status: UlipAdminStatus | null; loading: boolean } {
  const [status, setStatus] = useState<UlipAdminStatus | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let off = false
    fetch('/api/ulip/admin/status', { headers: authHeader(), signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : { admin: false }))
      .then((d) => { if (!off) { setStatus(d as UlipAdminStatus); setLoading(false) } })
      .catch(() => { if (!off) { setStatus({ admin: false }); setLoading(false) } })
    return () => { off = true }
  }, [])
  return { status, loading }
}

export interface UlipIdentity {
  insurerId: string | null
  insurerName: string | null
  month: string | null
  evidence: string[]
}

/** Dry run — report the insurer + month the PDF declares, without storing anything. */
export async function identifyFactsheet(file: File): Promise<UlipIdentity | { error: string }> {
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await fetch('/api/ulip/identify', {
      method: 'POST', headers: authHeader(), body: form, signal: AbortSignal.timeout(120_000),
    })
    if (res.status === 401) return { error: 'Not authorized — sign in as an admin.' }
    const d = await res.json().catch(() => ({}))
    if (!res.ok) return { error: (d as { error?: string }).error ?? `HTTP ${res.status}` }
    return d as UlipIdentity
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export interface UlipUploadResult {
  ok: boolean
  insurer: string | null
  insurerName: string | null
  month: string | null
  via: string
  stored: number
  byStatus: { clean: number; suspicious: number; failed: number }
  holdings: number
  replaced: boolean
  message: string
  evidence: string[]
}

/** Upload + ingest a factsheet. `insurer`/`month` override auto-detection; `force`
 *  confirms an override the server would otherwise refuse (mismatch or duplicate). */
export async function uploadFactsheet(
  file: File,
  opts: { insurer?: string; month?: string; force?: boolean } = {},
): Promise<UlipUploadResult> {
  const params = new URLSearchParams()
  if (opts.insurer) params.set('insurer', opts.insurer)
  if (opts.month) params.set('month', opts.month)
  if (opts.force) params.set('force', '1')
  const form = new FormData()
  form.append('file', file)
  const qs = params.toString()
  const empty = { insurer: null, insurerName: null, month: null, via: 'none', stored: 0, byStatus: { clean: 0, suspicious: 0, failed: 0 }, holdings: 0, replaced: false, evidence: [] }
  try {
    // Extraction of a full combined sheet runs for minutes — keep the client patient.
    const res = await fetch(`/api/ulip/upload${qs ? `?${qs}` : ''}`, {
      method: 'POST', headers: authHeader(), body: form, signal: AbortSignal.timeout(900_000),
    })
    if (res.status === 401) return { ...empty, ok: false, message: 'Not authorized — sign in as an admin.' }
    const d = (await res.json().catch(() => ({}))) as Partial<UlipUploadResult> & { error?: string }
    if (d.error && !d.message) return { ...empty, ok: false, message: d.error }
    return { ...empty, ok: false, message: `HTTP ${res.status}`, ...d } as UlipUploadResult
  } catch (e) {
    const err = e as Error
    const msg = err.name === 'TimeoutError'
      ? 'The upload timed out. The file was received — check the insurer\'s month before retrying.'
      : err.message
    return { ...empty, ok: false, message: msg }
  }
}

/** Re-parse an already-archived month (after an extractor fix) — no re-download. */
export async function reExtractMonth(insurer: string, month: string): Promise<UlipUploadResult> {
  const empty = { insurer: null, insurerName: null, month: null, via: 'none', stored: 0, byStatus: { clean: 0, suspicious: 0, failed: 0 }, holdings: 0, replaced: false, evidence: [] }
  try {
    const res = await fetch('/api/ulip/re-extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ insurer, month }), signal: AbortSignal.timeout(900_000),
    })
    if (res.status === 401) return { ...empty, ok: false, message: 'Not authorized — sign in as an admin.' }
    const d = (await res.json().catch(() => ({}))) as Partial<UlipUploadResult> & { error?: string }
    if (d.error && !d.message) return { ...empty, ok: false, message: d.error }
    return { ...empty, ok: false, message: `HTTP ${res.status}`, ...d } as UlipUploadResult
  } catch (e) {
    return { ...empty, ok: false, message: (e as Error).message }
  }
}
