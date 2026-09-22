import { useNavigate } from 'react-router-dom'
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, ChevronDown, Check } from 'lucide-react'
import { companies } from '../data/companies'
import { indices } from '../data/market'
import { UP, DOWN } from './CandleChart'
import { CompanyLogo } from './Logo'
import { ProfileMenu } from './ProfileMenu'
import { ThemeToggle } from '../lib/theme'
import { MobileNav } from './MobileNav'
import { useQuotes, useUniverse } from '../lib/api'
import { useDebounced } from '../lib/hooks'
import { useDismissable } from '../lib/useDismissable'

function QuoteChip({ name, value, changePct, live }: { name: string; value: number; changePct: number; live?: boolean }) {
  const up = changePct >= 0
  return (
    <div className="hidden items-center gap-2.5 xl:flex" title={live ? 'Delayed live quote' : 'Connecting…'}>
      <div className="text-right">
        <div className="text-[12.5px] font-bold leading-tight text-ink">
          {value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </div>
        <div className="flex items-center justify-end gap-1 text-[10px] font-medium leading-tight text-faint">
          {live && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#2ebd85]" />}
          {name}
        </div>
      </div>
      <span
        className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
        style={{ background: up ? '#e7f8f1' : '#fdeef0', color: up ? UP : DOWN }}
      >
        {up ? '+' : ''}{changePct.toFixed(2)}%
      </span>
    </div>
  )
}

const LANGS = [
  { label: 'English (India)', available: true },
  { label: 'हिन्दी', available: false },
  { label: 'ગુજરાતી', available: false },
]

export function Header() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [lang, setLang] = useState(LANGS[0].label)
  const [langOpen, setLangOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const langDismiss = useDismissable<HTMLDivElement, HTMLButtonElement>(langOpen, () => setLangOpen(false))

  // Debounce the query so the (potentially 500-row) universe filter runs after typing settles.
  const debouncedQ = useDebounced(q, 200)

  // Search across the FULL NIFTY 500 universe (curated companies ranked first)
  const { rows: universe } = useUniverse()
  const matches = debouncedQ.length >= 2
    ? (() => {
        const qq = debouncedQ.toUpperCase()
        const ql = debouncedQ.toLowerCase()
        const curated = companies
          .filter((c) => c.symbol.includes(qq) || c.name.toLowerCase().includes(ql))
          .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, domain: c.domain as string | undefined }))
        const curatedSet = new Set(curated.map((c) => c.symbol))
        const uni = universe
          .filter((r) => !curatedSet.has(r.symbol) && (r.symbol.includes(qq) || r.name.toLowerCase().includes(ql)))
          .map((r) => ({ symbol: r.symbol, name: r.name, sector: r.industry, domain: undefined as string | undefined }))
        return [...curated, ...uni].slice(0, 8)
      })()
    : []

  // Keep the highlighted option in range as the result set changes.
  useEffect(() => { setActiveIndex(-1) }, [debouncedQ])

  const openSearch = matches.length > 0
  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (!openSearch) { if (e.key === 'Escape') setQ(''); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % matches.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1)) }
    else if (e.key === 'Enter') {
      const pick = matches[activeIndex] ?? matches[0]
      if (pick) { navigate(`/company/${pick.symbol}`); setQ('') }
    } else if (e.key === 'Escape') { setQ('') }
  }

  // Live (delayed) index quotes — fall back to mock values until the API answers
  const liveQuotes = useQuotes(['NIFTY 50', 'SENSEX'])
  const nifty = { value: liveQuotes.get('NIFTY 50')?.price ?? indices[0].value, changePct: liveQuotes.get('NIFTY 50')?.changePct ?? indices[0].changePct, live: liveQuotes.has('NIFTY 50') }
  const sensex = { value: liveQuotes.get('SENSEX')?.price ?? indices[1].value, changePct: liveQuotes.get('SENSEX')?.changePct ?? indices[1].changePct, live: liveQuotes.has('SENSEX') }

  return (
    <header className="no-print relative z-30 flex items-center gap-2.5 border-b border-line bg-surface px-3 py-3 lg:gap-5 lg:px-5">
      {/* Mobile hamburger (hidden on desktop) */}
      <MobileNav />

      {/* Brand — gold rupee-coin mark */}
      <button onClick={() => navigate('/')} className="flex shrink-0 items-center text-left">
        <img
          src="/rupee-logo.png"
          alt="Bharat Market Pro"
          className="h-9 w-auto object-contain drop-shadow-sm lg:h-10"
        />
        <span className="ml-2 lg:ml-3.5">
          <span className="flex items-center gap-1.5 text-[14px] font-bold leading-tight tracking-tight text-ink lg:text-[16px]">
            Bharat <span className="text-up">Market Pro</span> <span className="hidden text-[12px] sm:inline">🇮🇳</span>
          </span>
          <span className="hidden text-[10.5px] font-medium leading-tight text-faint sm:block">
            see beyond the ticker
          </span>
        </span>
      </button>

      <span className="ml-2 hidden h-8 w-px bg-panel lg:block" />

      {/* Language menu */}
      <div className="relative z-40 ml-1 hidden lg:block">
        <button
          ref={langDismiss.triggerRef}
          onClick={() => setLangOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={langOpen}
          className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-muted shadow-sm transition hover:bg-panel"
        >
          {lang} <ChevronDown size={12} className={`text-faint transition-transform duration-200 ${langOpen ? 'rotate-180' : ''}`} />
        </button>
        {langOpen && (
          <div ref={langDismiss.panelRef} role="listbox" aria-label="Language" className="absolute left-0 top-full z-40 mt-2 w-48 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgba(16,24,40,0.14)]">
            {LANGS.map((l) => (
              <button
                key={l.label}
                role="option"
                aria-selected={lang === l.label}
                disabled={!l.available}
                onClick={() => { setLang(l.label); setLangOpen(false) }}
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-[12px] font-semibold text-strong transition-colors hover:bg-panel disabled:cursor-not-allowed disabled:opacity-45"
              >
                {l.label}
                {l.available ? (lang === l.label && <Check size={13} className="text-up" />) : (
                  <span className="text-[9px] font-bold uppercase text-faint">Phase 2</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative w-full min-w-0 flex-1 lg:mx-auto lg:max-w-md lg:flex-none">
        <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
          role="combobox"
          aria-expanded={openSearch}
          aria-controls="header-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 && matches[activeIndex] ? `search-opt-${matches[activeIndex].symbol}` : undefined}
          placeholder="Search companies, e.g. SBILIFE…"
          className="w-full rounded-full border border-line bg-panel py-2 pl-10 pr-4 text-[13px] text-ink transition-all duration-200 placeholder:text-faint focus:border-line focus:bg-surface focus:shadow-[0_4px_20px_rgba(16,24,40,0.08)] focus:outline-none"
        />
        {openSearch && (
          <div id="header-search-listbox" role="listbox" aria-label="Company search results" className="absolute left-0 top-full z-50 mt-2 w-full overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgba(16,24,40,0.14)]">
            {matches.map((c, i) => (
              <button
                key={c.symbol}
                id={`search-opt-${c.symbol}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => { navigate(`/company/${c.symbol}`); setQ('') }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${i === activeIndex ? 'bg-panel' : 'hover:bg-panel'}`}
              >
                <CompanyLogo domain={c.domain} symbol={c.symbol} sector={c.sector} />
                <span className="flex-1 text-[13px] font-semibold text-ink">{c.name}</span>
                <span className="font-mono text-[10.5px] text-faint">{c.symbol}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Index quotes */}
      <QuoteChip name="NIFTY 50" value={nifty.value} changePct={nifty.changePct} live={nifty.live} />
      <QuoteChip name="SENSEX" value={sensex.value} changePct={sensex.changePct} live={sensex.live} />

      {/* Light/dark toggle + profile / auth menu (real Supabase login) */}
      <ThemeToggle className="hidden sm:inline-flex" />
      <ProfileMenu />
    </header>
  )
}
