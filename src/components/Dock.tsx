// Bottom dock: watchlist companies as taskbar tabs (any NIFTY 500 symbol),
// plus a working add/manage popover — search the universe, add, remove.

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, X, Search } from 'lucide-react'
import { companyBySymbol } from '../data/companies'
import { useWatchlist } from '../lib/watchlist'
import { useUniverse } from '../lib/api'
import { useDismissable } from '../lib/useDismissable'
import { CompanyLogo, Monogram } from './Logo'

export function Dock() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { symbols, toggle } = useWatchlist()
  const { rows: universe } = useUniverse()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const dismiss = useDismissable<HTMLDivElement, HTMLButtonElement>(open, () => setOpen(false))

  // Resolve every watchlist symbol: curated company OR universe row
  const tabs = symbols.slice(0, 7).map((s) => {
    const curated = companyBySymbol.get(s)
    const uni = universe.find((r) => r.symbol === s)
    return {
      symbol: s,
      name: curated?.name ?? uni?.name ?? s,
      sector: curated?.sector ?? uni?.industry ?? '',
      domain: curated?.domain,
    }
  })

  const ql = q.toLowerCase()
  const results = q.length >= 2
    ? universe.filter((r) => r.symbol.toLowerCase().includes(ql) || r.name.toLowerCase().includes(ql)).slice(0, 8)
    : []

  return (
    <div className="no-print relative hidden items-center justify-center gap-2 border-t border-line bg-surface px-4 py-2.5 lg:flex">
      {tabs.map((t) => {
        const active = pathname === `/company/${t.symbol}`
        return (
          <button
            key={t.symbol}
            onClick={() => navigate(`/company/${t.symbol}`)}
            className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(16,24,40,0.1)] ${
              active ? 'border-inkfill bg-inkfill text-white' : 'border-line bg-surface text-muted'
            }`}
          >
            <CompanyLogo domain={t.domain} symbol={t.symbol} sector={t.sector} size={18} />
            {t.name.length > 22 ? t.symbol : t.name}
          </button>
        )
      })}

      {/* Add / manage watchlist */}
      <button
        ref={dismiss.triggerRef}
        onClick={() => { setOpen((o) => !o); setQ('') }}
        title="Add or manage watchlist companies"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add or manage watchlist companies"
        className={`flex h-8 w-8 items-center justify-center rounded-full border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(16,24,40,0.1)] ${
          open ? 'border-inkfill bg-inkfill text-white' : 'border-line bg-surface text-faint hover:text-strong'
        }`}
      >
        <Plus size={15} className={`transition-transform duration-200 ${open ? 'rotate-45' : ''}`} />
      </button>

      {open && (
        <>
          <div ref={dismiss.panelRef} className="absolute bottom-full right-6 z-50 mb-2 w-[380px] rounded-2xl border border-line bg-surface p-3.5 shadow-[0_-8px_40px_rgba(16,24,40,0.16)]">
            <h4 className="mb-2.5 text-[13px] font-bold text-ink">Manage watchlist</h4>

            {/* Add: search the full NIFTY 500 */}
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search NIFTY 500 to add — e.g. TATASTEEL…"
                className="w-full rounded-full border border-line bg-panel py-2 pl-9 pr-3 text-[12.5px] focus:border-line focus:bg-surface focus:outline-none"
              />
            </div>
            {results.length > 0 && (
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-line">
                {results.map((r) => {
                  const inList = symbols.includes(r.symbol)
                  return (
                    <button
                      key={r.symbol}
                      onClick={() => { if (!inList) toggle(r.symbol); setQ('') }}
                      disabled={inList}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-panel disabled:opacity-50"
                    >
                      <Monogram symbol={r.symbol} sector={r.industry} size={20} />
                      <span className="flex-1 truncate text-[12px] font-semibold text-strong">{r.name}</span>
                      <span className="font-mono text-[10px] text-faint">{r.symbol}</span>
                      <span className={`text-[10px] font-bold ${inList ? 'text-faint' : 'text-up'}`}>{inList ? 'Added' : '+ Add'}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Current list with remove */}
            <div className="mt-3 border-t border-line pt-2.5">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-faint">On your watchlist ({symbols.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {symbols.map((s) => (
                  <span key={s} className="flex items-center gap-1.5 rounded-full bg-panel py-1 pl-2.5 pr-1.5 text-[11px] font-bold text-strong">
                    {s}
                    <button
                      onClick={() => toggle(s)}
                      title={`Remove ${s}`}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-faint transition-colors hover:bg-down-soft hover:text-down"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {symbols.length === 0 && <span className="text-[11px] italic text-faint">Empty — search above to add companies.</span>}
              </div>
              <p className="mt-2 text-[10px] text-faint">First 7 show as dock tabs. Any NIFTY 500 company works.</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
