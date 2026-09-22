// Optional auth: verify Supabase-issued JWTs. Supabase issues + manages the tokens;
// here we only verify the signature and read the user id/email. Supports BOTH:
//   • HS256 — legacy shared secret (SUPABASE_JWT_SECRET), no network call; and
//   • ES256 / RS256 — modern asymmetric signing keys, verified against the project's
//     public JWKS (fetched from SUPABASE_URL and cached). New Supabase projects
//     default to ES256, so this path is what actually runs for them.
// If neither a secret nor a URL is set, auth is disabled and watchlist sync isn't offered.
import { createHmac, createPublicKey, verify, timingSafeEqual } from 'node:crypto'

export interface AuthUser {
  sub: string
  email: string | null
  /** M-S1: whether Supabase confirmed the email. Gates that TRUST the email claim
   *  (e.g. the owner allow-list) must require this; gates keyed on `sub` need not. */
  emailVerified: boolean
}

/** M-S1: a token is safe to trust the EMAIL claim on only when it's verified AND the
 *  address is confirmed. Use this in any gate that allow-lists by email address. */
export function emailTrusted(user: AuthUser | null): user is AuthUser & { email: string } {
  return Boolean(user && user.email && user.emailVerified)
}

/** Base project URL (strip a trailing slash and any /rest/v1 the user pasted). */
function supabaseUrl(): string | undefined {
  const u = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  if (!u) return undefined
  return u.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/auth\/v1$/, '')
}

export function authEnabled(): boolean {
  return Boolean(process.env.SUPABASE_JWT_SECRET || supabaseUrl())
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// ——— JWKS (asymmetric public keys) cache ———
type Jwk = { kid?: string; alg?: string; kty?: string; [k: string]: unknown }
let jwksCache: { keys: Jwk[]; at: number } | null = null

async function getJwks(forceRefresh = false): Promise<Jwk[]> {
  const base = supabaseUrl()
  if (!base) return []
  const fresh = jwksCache && Date.now() - jwksCache.at < 3_600_000
  if (fresh && !forceRefresh) return jwksCache!.keys
  try {
    const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return jwksCache?.keys ?? []
    const data = (await res.json()) as { keys?: Jwk[] }
    jwksCache = { keys: data.keys ?? [], at: Date.now() }
    return jwksCache.keys
  } catch {
    return jwksCache?.keys ?? []
  }
}

/** Verify a Supabase JWT (HS256 or ES256/RS256) and return the user, or null. */
export async function verifySupabaseJwt(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  let header: { alg?: string; kid?: string }
  let payload: {
    sub?: string
    email?: string
    exp?: number
    iss?: string
    aud?: string | string[]
    email_verified?: boolean
    user_metadata?: { email_verified?: boolean }
  }
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'))
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'))
  } catch {
    return null
  }
  if (!payload.sub) return null
  // L: reject tokens without an expiry (a token that never expires can't be revoked by lapse).
  if (typeof payload.exp !== 'number') return null
  if (Date.now() / 1000 > payload.exp) return null // expired

  // L / M-S1: issuer + audience checks (defense in depth). Supabase iss = <url>/auth/v1,
  // aud = 'authenticated' by default. Only enforced when the claim is present so we don't
  // break setups that omit it; override the expected audience via SUPABASE_JWT_AUD.
  const base = supabaseUrl()
  if (base && payload.iss && payload.iss !== `${base}/auth/v1`) return null
  const expectedAud = process.env.SUPABASE_JWT_AUD ?? 'authenticated'
  if (payload.aud != null) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!auds.includes(expectedAud)) return null
  }

  const emailVerified = Boolean(payload.email_verified ?? payload.user_metadata?.email_verified)
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`)
  const signature = b64urlToBuf(sigB64)
  const ok = (u: AuthUser | null) => u

  // HS256 — legacy shared secret.
  if (header.alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET
    if (!secret) return null
    const expected = createHmac('sha256', secret).update(signingInput).digest()
    if (expected.length === signature.length && timingSafeEqual(expected, signature)) {
      return ok({ sub: payload.sub, email: payload.email ?? null, emailVerified })
    }
    return null
  }

  // ES256 / RS256 — asymmetric, verified against the project's public JWKS.
  if (header.alg === 'ES256' || header.alg === 'RS256') {
    for (const attempt of [false, true]) {
      const keys = await getJwks(attempt) // refetch on a kid miss (key rotation)
      const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined)
      if (!jwk) continue
      try {
        const pub = createPublicKey({ key: jwk, format: 'jwk' })
        const valid =
          header.alg === 'ES256'
            ? verify('sha256', signingInput, { key: pub, dsaEncoding: 'ieee-p1363' }, signature)
            : verify('RSA-SHA256', signingInput, pub, signature)
        if (valid) return ok({ sub: payload.sub, email: payload.email ?? null, emailVerified })
        return null
      } catch {
        return null
      }
    }
    return null
  }

  return null
}

/** True when the header carries a well-formed JWT whose `exp` has already passed.
 *
 *  Reads the UNVERIFIED payload, so it must never be used to grant anything — its only
 *  job is to let a gate answer "your session lapsed" (401, client renews and retries)
 *  distinctly from "you have no access" (404, section stays hidden). Claiming an expired
 *  token grants nothing, so the distinction leaks nothing to an attacker. */
export function bearerExpired(authHeader: string | undefined | null): boolean {
  if (!authHeader) return false
  const token = /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1]
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp
  } catch {
    return false
  }
}

/** Extract + verify the bearer token from an Authorization header. */
export async function userFromAuthHeader(authHeader: string | undefined | null): Promise<AuthUser | null> {
  if (!authHeader) return null
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  return m ? verifySupabaseJwt(m[1]) : null
}
