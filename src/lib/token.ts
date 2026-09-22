// Module-level bridge for the current Supabase access token, kept in sync by
// AuthProvider. Plain fetch helpers (alerts, rule-alerts) that live outside the React
// tree read it to attach Authorization — the server requires a login on mutating
// alert endpoints.
export const tokenStore = { current: null as string | null }

export function authHeader(): Record<string, string> {
  return tokenStore.current ? { Authorization: `Bearer ${tokenStore.current}` } : {}
}

// ——— session recovery ———
// Supabase access tokens expire ~1h after sign-in. supabase-js renews them on a timer,
// but browsers throttle timers in a backgrounded tab, so a page left open can keep
// replaying a dead token indefinitely. AuthProvider registers a refresher here and any
// caller that sees a 401 can force a renewal + retry instead of silently rendering empty.
type Refresher = () => Promise<string | null>
let refresher: Refresher | null = null

/** Called once by AuthProvider when the Supabase client is ready. */
export function setSessionRefresher(fn: Refresher | null): void {
  refresher = fn
}

/** Force-renew the access token. Returns the new token, or null when there's no
 *  session to renew (signed out, or the refresh token itself has lapsed). */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refresher) return null
  try {
    const next = await refresher()
    return next
  } catch {
    return null
  }
}
