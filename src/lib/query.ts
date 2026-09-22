// Tiny stale-while-revalidate query cache — a deliberately small stand-in for a
// query library (TanStack Query) so we get per-URL dedupe + a shared cache without
// a new dependency or a build/typecheck risk. Multiple components subscribing to the
// same key share one in-flight request and one cached result; navigating away and back
// no longer refires a 45s /api/company-feed.
import { useEffect, useRef, useState } from 'react'

interface CacheEntry<T> {
  data: T | undefined
  error: unknown
  promise: Promise<T> | null
  ts: number // last successful fetch time (0 = never / stale)
  subs: Set<() => void>
  fetcher: (() => Promise<T>) | null // last fetcher, so invalidate() can refetch mounted keys
}

const cache = new Map<string, CacheEntry<unknown>>()
const DEFAULT_TTL = 60_000

function getEntry<T>(key: string): CacheEntry<T> {
  let e = cache.get(key) as CacheEntry<T> | undefined
  if (!e) {
    e = { data: undefined, error: undefined, promise: null, ts: 0, subs: new Set(), fetcher: null }
    cache.set(key, e as CacheEntry<unknown>)
  }
  return e
}

function notify(e: CacheEntry<unknown>) {
  for (const s of e.subs) s()
}

/**
 * Mark a key (or every key with the given prefix) stale. Mounted queries (those with
 * live subscribers) refetch immediately; idle keys refetch on their next mount.
 */
export function invalidate(prefix: string) {
  for (const [k, e] of cache) {
    if (k === prefix || k.startsWith(prefix)) {
      e.ts = 0
      if (e.subs.size > 0 && e.fetcher) revalidate(k, e.fetcher).catch(() => {})
      else notify(e)
    }
  }
}

function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const e = getEntry<T>(key)
  e.fetcher = fetcher
  if (e.promise) return e.promise // in-flight dedupe
  const p = (async () => {
    try {
      const data = await fetcher()
      e.data = data
      e.error = undefined
      e.ts = Date.now()
      return data
    } catch (err) {
      e.error = err
      throw err
    } finally {
      e.promise = null
      notify(e as CacheEntry<unknown>)
    }
  })()
  e.promise = p
  return p
}

export interface QueryOptions {
  /** Consider cached data fresh for this many ms before revalidating on mount. */
  ttl?: number
  /** When false the query is inert (used while a key isn't ready). */
  enabled?: boolean
  /** Poll on an interval (ms) while mounted. */
  refetchInterval?: number
}

export interface QueryResult<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  refetch: () => Promise<T | undefined>
}

/**
 * Subscribe to a cached fetch keyed by `key` (typically the request URL). Passing
 * `null` disables the query (returns loading:false, data:undefined).
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, opts: QueryOptions = {}): QueryResult<T> {
  const { ttl = DEFAULT_TTL, enabled = true, refetchInterval } = opts
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const [, force] = useState(0)

  useEffect(() => {
    if (!key || !enabled) return
    const rerender = () => force((n) => n + 1)
    const e = getEntry<T>(key)
    e.subs.add(rerender)
    const fresh = e.data !== undefined && Date.now() - e.ts < ttl
    if (!fresh) revalidate(key, fetcherRef.current).catch(() => {})
    else rerender()
    let interval: ReturnType<typeof setInterval> | undefined
    if (refetchInterval) interval = setInterval(() => revalidate(key, fetcherRef.current).catch(() => {}), refetchInterval)
    return () => {
      e.subs.delete(rerender)
      if (interval) clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, ttl, refetchInterval])

  const entry = key ? (cache.get(key) as CacheEntry<T> | undefined) : undefined
  return {
    data: entry?.data,
    error: entry?.error,
    loading: Boolean(enabled && key && entry?.data === undefined && entry?.error === undefined),
    refetch: () => (key ? revalidate(key, fetcherRef.current) : Promise.resolve(undefined)),
  }
}
