import { NavLink } from 'react-router-dom'
import {
  CandlestickChart, Star, Building2, Umbrella, Newspaper, FileText,
  ShieldAlert, MessageSquareText, FileBarChart, Crosshair, Wallet,
} from 'lucide-react'
import { useGuidanceAccess } from '../lib/guidance'

// Shared nav model — also consumed by the mobile drawer (MobileNav).
export const NAV_ITEMS = [
  { to: '/', label: 'Terminal', icon: CandlestickChart },
  { to: '/watchlist', label: 'Watchlist', icon: Star },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/insurance', label: 'Insurance Monitor', icon: Umbrella },
  { to: '/news', label: 'News Intelligence', icon: Newspaper },
  { to: '/filings', label: 'Filing Intelligence', icon: FileText },
  { to: '/risk', label: 'Risk Monitor', icon: ShieldAlert },
  { to: '/chat', label: 'Research Chat', icon: MessageSquareText },
  { to: '/reports', label: 'Reports', icon: FileBarChart },
]
const nav = NAV_ITEMS

/**
 * Navigation rail: 64px of icons at rest; hovering anywhere on it expands the
 * rail to show every label, then it collapses back when the pointer leaves.
 */
export function IconRail() {
  // PRIVATE guidance desk appears in the rail ONLY when the server reports the owner
  // has access (otherwise the probe 404s and the item stays hidden).
  const guidance = useGuidanceAccess()
  const items = guidance.enabled
    ? [...nav, { to: '/guidance', label: 'Investment Guidance', icon: Crosshair }, { to: '/portfolio', label: 'My Investments', icon: Wallet }]
    : nav
  return (
    <aside className="no-print group z-30 hidden h-full w-[64px] shrink-0 flex-col gap-1.5 overflow-hidden border-r border-line bg-surface py-4 transition-[width] duration-300 ease-out hover:w-[212px] hover:shadow-[8px_0_24px_rgba(16,24,40,0.06)] lg:flex">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          title={label}
          className={({ isActive }) =>
            `mx-2.5 flex h-11 items-center rounded-2xl transition-colors duration-200 ${
              isActive
                ? 'bg-inkfill text-white shadow-[0_6px_16px_rgba(22,24,29,0.25)]'
                : 'text-faint hover:bg-panel hover:text-strong'
            }`
          }
        >
          <span className="flex w-11 shrink-0 items-center justify-center">
            <Icon size={18} strokeWidth={1.9} />
          </span>
          <span className="-translate-x-1.5 whitespace-nowrap text-[12.5px] font-semibold opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100">
            {label}
          </span>
        </NavLink>
      ))}
    </aside>
  )
}
