// Watchlist state. Two strictly separated scopes so one never leaks into the other:
//   • Anonymous  — a browser-local list (localStorage), used when signed out.
//   • Account    — a PRIVATE per-user list on the server (keyed by user id).
// On sign-in the local list is merged INTO the account once (so you don't lose your
// picks), then the account list is the source of truth and edits sync up. While signed
// in we do NOT write the account list into the shared local store, and on sign-out we
// revert to the anonymous local list — so a public/next user never sees your account.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './auth'
import { useToast } from './toast'

const STORAGE_KEY = 'bharatmarketpro.watchlist'
const DEFAULT_WATCHLIST = ['RELIANCE', 'HDFCBANK', 'SBILIFE', 'TCS', 'BAJFINANCE']

function readLocal(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : DEFAULT_WATCHLIST
  } catch {
    return DEFAULT_WATCHLIST
  }
}

interface WatchlistCtx {
  symbols: string[]
  has: (symbol: string) => boolean
  toggle: (symbol: string) => void
  synced: boolean
}

const Ctx = createContext<WatchlistCtx>({ symbols: [], has: () => false, toggle: () => {}, synced: false })

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const { user, token } = useAuth()
  const { toast } = useToast()
  const [symbols, setSymbols] = useState<string[]>(readLocal)
  const [synced, setSynced] = useState(false)
  const symbolsRef = useRef(symbols)
  symbolsRef.current = symbols
  const mergedFor = useRef<string | null>(null)
  // Set true when adoption replaces `symbols` from the server, so the push effect that
  // fires for that change doesn't immediately echo it back (and doesn't race the GET).
  const justAdopted = useRef(false)

  // Persist ONLY the anonymous list. While signed in, the account (server) is the source
  // of truth — never write the account's private list into the shared browser store.
  useEffect(() => {
    if (!user) localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols))
  }, [symbols, user])

  // Sign-in: load THIS account's private list and adopt it (so removals stick and one
  // user's list never bleeds into another). Only a brand-new/empty account is seeded
  // from this browser's list. Sign-out: revert to the anonymous local list.
  useEffect(() => {
    if (!user || !token) {
      if (mergedFor.current) {
        mergedFor.current = null
        setSynced(false)
        setSymbols(readLocal()) // revert to the private/anonymous local list
      }
      return
    }
    if (mergedFor.current === user.id) return
    // Adopt the account list BEFORE claiming this account as merged, so a mid-flight
    // edit isn't pushed to (or clobbered by) a half-initialised sync.
    let cancelled = false
    fetch('/api/watchlist', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        const account = Array.isArray(d?.symbols) ? (d.symbols as string[]) : []
        if (account.length > 0) {
          justAdopted.current = true
          setSymbols(account) // returning user — their private list wins
        } else {
          // new/empty account — seed it once from this browser's list
          const local = symbolsRef.current
          fetch('/api/watchlist', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ symbols: local }),
          }).catch(() => toast('Could not save your watchlist to your account.'))
        }
        mergedFor.current = user.id // claim merged only after adoption completes
        setSynced(true)
      })
      .catch(() => { if (!cancelled) toast('Could not sync your watchlist from your account.') })
    return () => { cancelled = true }
  }, [user, token, toast])

  // While signed in, push edits up to the (private) account — but never echo an
  // adoption (that change came FROM the account, not a user edit).
  useEffect(() => {
    if (!user || !token || mergedFor.current !== user.id) return
    if (justAdopted.current) { justAdopted.current = false; return }
    fetch('/api/watchlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ symbols }),
    }).catch(() => toast('Could not save your watchlist change — it may not persist.'))
  }, [symbols, user, token, toast])

  const has = (symbol: string) => symbols.includes(symbol)
  const toggle = (symbol: string) =>
    setSymbols((prev) => (prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]))

  return <Ctx.Provider value={{ symbols, has, toggle, synced }}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook and provider intentionally share this module
export function useWatchlist() {
  return useContext(Ctx)
}
