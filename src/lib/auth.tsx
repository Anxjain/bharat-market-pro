// Optional auth (Supabase) — the ONLY purpose is server-side watchlist sync.
// No feature is gated. If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are unset,
// auth is simply disabled and everything runs anonymously (browser-local).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
// Type-only import (erased at build) — the actual supabase-js bundle is dynamically
// imported below ONLY when VITE_SUPABASE_* is configured, so it leaves the entry chunk.
import type { SupabaseClient, Session } from '@supabase/supabase-js'
import { tokenStore, setSessionRefresher } from './token'

const env = import.meta.env as Record<string, string | undefined>
const URL = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
export const authConfigured = Boolean(URL && ANON)

export interface AuthUser { id: string; email: string | null }
interface AuthCtx {
  enabled: boolean
  user: AuthUser | null
  token: string | null
  signInEmail: (email: string, password: string) => Promise<{ error?: string }>
  signUpEmail: (email: string, password: string) => Promise<{ error?: string; needsConfirm?: boolean }>
  signInGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx>({
  enabled: false,
  user: null,
  token: null,
  signInEmail: async () => ({ error: 'auth disabled' }),
  signUpEmail: async () => ({ error: 'auth disabled' }),
  signInGoogle: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const clientRef = useRef<SupabaseClient | null>(null)

  useEffect(() => {
    if (!authConfigured) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    ;(async () => {
      const { createClient } = await import('@supabase/supabase-js')
      if (cancelled) return
      const client = createClient(URL as string, ANON as string)
      clientRef.current = client
      const { data } = await client.auth.getSession()
      if (cancelled) return
      setSession(data.session)
      const { data: sub } = client.auth.onAuthStateChange((_e, s) => setSession(s))
      unsubscribe = () => sub.subscription.unsubscribe()

      // Let non-React callers force a token renewal when the API rejects a stale one.
      setSessionRefresher(async () => {
        const { data: r } = await client.auth.refreshSession()
        if (r.session) setSession(r.session)
        return r.session?.access_token ?? null
      })
    })()
    return () => { cancelled = true; unsubscribe?.(); setSessionRefresher(null) }
  }, [])

  // A backgrounded tab has its timers throttled, so supabase-js can miss the renewal
  // tick and the app comes back holding an expired token. Re-check on refocus: getSession()
  // renews when needed and is a no-op when the token is still good.
  useEffect(() => {
    if (!authConfigured) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const client = clientRef.current
      if (!client) return
      client.auth.getSession().then(({ data }) => { if (data.session) setSession(data.session) }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  const user: AuthUser | null = session?.user ? { id: session.user.id, email: session.user.email ?? null } : null
  const token = session?.access_token ?? null
  // Mirror into the module-level store so non-React fetch helpers can send it.
  tokenStore.current = token

  const value: AuthCtx = {
    enabled: authConfigured,
    user,
    token,
    signInEmail: async (email, password) => {
      const client = clientRef.current
      if (!client) return { error: 'auth not ready' }
      const { error } = await client.auth.signInWithPassword({ email, password })
      return { error: error?.message }
    },
    signUpEmail: async (email, password) => {
      const client = clientRef.current
      if (!client) return { error: 'auth not ready' }
      // With "Confirm email" ON in Supabase, this sends a verification link; the user
      // has no session until they click it. Redirect the link back to the app.
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
      if (error) return { error: error.message }
      return { needsConfirm: !data.session }
    },
    signInGoogle: async () => {
      const client = clientRef.current
      if (!client) return
      await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })
    },
    signOut: async () => { await clientRef.current?.auth.signOut() },
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider share this module
export function useAuth() {
  return useContext(Ctx)
}
