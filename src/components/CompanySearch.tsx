// Reusable company autocomplete over the live NIFTY-500 universe (same cached fetch
// the header search uses). Unlike the header, picking a result calls onPick instead of
// navigating — the guidance desk jumps to a verdict, the mock-order ticket fills itself.
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { useUniverse } from '../lib/api'
import { useDebounced } from '../lib/hooks'
import { CompanyLogo } from './Logo'

export interface CompanyPick {
  symbol: string
  name: string
  close: number | null
}

export function CompanySearch({ placeholder, onPick, className = '' }: {
  placeholder: string
  onPick: (pick: CompanyPick) => void
  className?: string
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(-1)
  const debounced = useDebounced(q, 150)
  const { rows } = useUniverse()

  const matches = debounced.length >= 2
    ? (() => {
        const qq = debounced.toUpperCase()
        const ql = debounced.toLowerCase()
        return rows.filter((r) => r.symbol.includes(qq) || r.name.toLowerCase().includes(ql)).slice(0, 8)
      })()
    : []
  useEffect(() => { setActive(-1) }, [debounced])

  const pick = (i: number) => {
    const m = matches[i] ?? matches[0]
    if (m) { onPick({ symbol: m.symbol, name: m.name, close: m.close }); setQ('') }
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) { if (e.key === 'Escape') setQ(''); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? matches.length - 1 : i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active) }
    else if (e.key === 'Escape') setQ('')
  }

  return (
    <div className={`relative ${className}`}>
      <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-autocomplete="list"
        placeholder={placeholder}
        className="w-full rounded-full border border-line bg-panel py-2 pl-9 pr-4 text-[13px] text-ink transition-all duration-200 placeholder:text-faint focus:border-line focus:bg-surface focus:shadow-[0_4px_20px_rgba(16,24,40,0.08)] focus:outline-none"
      />
      {matches.length > 0 && (
        <div role="listbox" className="absolute left-0 top-full z-50 mt-2 w-full overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgba(16,24,40,0.14)]">
          {matches.map((m, i) => (
            <button
              key={m.symbol}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${i === active ? 'bg-panel' : 'hover:bg-panel'}`}
            >
              <CompanyLogo domain={m.domain ?? undefined} symbol={m.symbol} sector={m.industry} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{m.name}</span>
              <span className="font-mono text-[10.5px] text-faint">{m.symbol}</span>
              {m.close != null && (
                <span className="text-[11.5px] font-semibold tabular-nums text-strong">
                  ₹{m.close.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  {m.changePct != null && (
                    <span className={`ml-1.5 text-[10.5px] ${m.changePct >= 0 ? 'text-up' : 'text-down'}`}>{m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(1)}%</span>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
