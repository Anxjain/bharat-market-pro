// Mobile navigation: a hamburger button (shown only below lg) that opens a
// slide-in drawer listing every section. Desktop uses the IconRail instead —
// this component is hidden at lg and up. Shares NAV_ITEMS with the rail.
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Menu, X, Crosshair, Wallet } from 'lucide-react'
import { NAV_ITEMS } from './IconRail'
import { useGuidanceAccess } from '../lib/guidance'

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  // Mirror the desktop rail: the PRIVATE guidance desk appears for owners only.
  const guidance = useGuidanceAccess()
  const items = guidance.enabled
    ? [...NAV_ITEMS, { to: '/guidance', label: 'Investment Guidance', icon: Crosshair }, { to: '/portfolio', label: 'My Investments', icon: Wallet }]
    : NAV_ITEMS

  // Close the drawer on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="no-print flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-muted shadow-sm lg:hidden"
      >
        <Menu size={18} />
      </button>

      {/* Drawer — always mounted so it can slide; pointer-events off when closed. */}
      <div className={`fixed inset-0 z-[70] lg:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
        <div
          className={`absolute inset-0 bg-inkfill/40 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`}
          onClick={close}
        />
        <aside
          className={`absolute left-0 top-0 flex h-full w-[268px] max-w-[82%] flex-col bg-surface shadow-[12px_0_40px_rgba(16,24,40,0.22)] transition-transform duration-300 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
            <span className="flex items-center gap-2">
              <img src="/rupee-logo.png" alt="Bharat Market Pro" className="h-8 w-auto object-contain" />
              <span className="text-[14px] font-bold tracking-tight text-ink">Bharat <span className="text-up">Market Pro</span></span>
            </span>
            <button onClick={close} aria-label="Close menu" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint hover:bg-panel hover:text-strong">
              <X size={18} />
            </button>
          </div>

          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5">
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={close}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl px-3.5 py-3 text-[13.5px] font-semibold transition-colors ${
                    isActive ? 'bg-inkfill text-white' : 'text-muted hover:bg-panel'
                  }`
                }
              >
                <Icon size={18} strokeWidth={1.9} />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
      </div>
    </>
  )
}
