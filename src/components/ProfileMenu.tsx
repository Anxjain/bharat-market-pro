// Top-right profile menu: real Supabase auth state + sign-in form. Logged out shows
// a compact email/password + Google form; logged in shows the account + sign-out.
// This is the single place to sign in (the Watchlist page no longer carries it).
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, LogOut, Star, Moon, Sun } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/theme'
import { useDismissable } from '../lib/useDismissable'

const rowCls = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold text-strong transition-colors hover:bg-panel'
const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-strong outline-none focus:border-[#7a5cff]'

export function ProfileMenu() {
  const { enabled, user, signInEmail, signUpEmail, signInGoogle, signOut } = useAuth()
  const { theme, toggle: toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dismiss = useDismissable<HTMLDivElement, HTMLButtonElement>(open, () => setOpen(false))

  const initials = user?.email ? user.email.replace(/@.*/, '').slice(0, 2).toUpperCase() : null

  const submit = async () => {
    setBusy(true); setErr(null)
    if (mode === 'in') {
      const { error } = await signInEmail(email, pw)
      if (error) setErr(error)
      else setPw('')
    } else {
      const r = await signUpEmail(email, pw)
      if (r.error) setErr(r.error)
      else {
        setPw('')
        // needsConfirm = Supabase sent a verification link (Confirm-email ON); there is
        // no session until they click it, so tell them to go to their inbox.
        setErr(r.needsConfirm ? 'Account created — check your email for the verification link, then sign in.' : 'Account created — you can sign in now.')
      }
    }
    setBusy(false)
  }

  return (
    <div className="relative z-40 shrink-0">
      <button ref={dismiss.triggerRef} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="relative z-40 block transition-transform hover:scale-105" title={user ? user.email ?? 'account' : 'Sign in'}>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#16181d] to-[#3a3f4a] text-[12px] font-bold text-white">
          {initials ?? <User size={16} />}
        </span>
        {user && <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-[#2ebd85] px-1.5 text-[7.5px] font-bold uppercase tracking-wider text-white">In</span>}
      </button>

      {open && (
        <div ref={dismiss.panelRef} className="absolute right-0 top-full z-40 mt-2 w-[290px] overflow-hidden rounded-2xl border border-line bg-surface p-3 shadow-[0_16px_40px_rgba(16,24,40,0.16)]">
          {user ? (
            <div>
              <div className="px-1 pb-2">
                <div className="truncate text-[13px] font-bold text-ink">{user.email ?? 'Your account'}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] font-semibold text-up"><Star size={11} /> Watchlist synced to your account</div>
              </div>
              <div className="my-1 border-t border-line" />
              <button onClick={() => { navigate('/watchlist'); setOpen(false) }} className={rowCls}><Star size={14} className="text-faint" /> My watchlist</button>
              <button onClick={() => { signOut(); setOpen(false) }} className={`${rowCls} text-down hover:bg-down-soft`}><LogOut size={14} /> Sign out</button>
            </div>
          ) : enabled ? (
            <div>
              <div className="px-1 text-[13px] font-bold text-ink">{mode === 'in' ? 'Sign in' : 'Create your account'}</div>
              <div className="mt-0.5 px-1 text-[11px] text-faint">Save your watchlist across devices.</div>
              <div className="mt-3 space-y-2">
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" autoComplete="email" className={inputCls} />
                <input value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} className={inputCls} />
                <button onClick={submit} disabled={busy || !email || !pw} className="w-full rounded-lg bg-inkfill px-3 py-2 text-[12.5px] font-bold text-white transition-opacity disabled:opacity-40">
                  {busy ? '…' : mode === 'in' ? 'Sign in' : 'Sign up'}
                </button>
                <button onClick={() => signInGoogle()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px] font-bold text-strong transition-colors hover:border-inkfill">
                  Continue with Google
                </button>
              </div>
              {err && <p className={`mt-2 px-1 text-[11px] ${err.includes('created') ? 'text-up' : 'text-down'}`}>{err}</p>}
              <button onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null) }} className="mt-2 px-1 text-[11px] font-semibold text-[#2186c4] hover:underline">
                {mode === 'in' ? "New here? Create an account" : 'Have an account? Sign in'}
              </button>
            </div>
          ) : (
            <div className="px-1 py-2 text-[12px] text-muted">Accounts aren’t configured — your watchlist is saved in this browser.</div>
          )}
          {/* Theme toggle — available on mobile where the header button is hidden. */}
          <div className="my-1 border-t border-line" />
          <button onClick={toggleTheme} className={rowCls}>
            {theme === 'dark' ? <Sun size={14} className="text-faint" /> : <Moon size={14} className="text-faint" />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      )}
    </div>
  )
}
