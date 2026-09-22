// Company logos: real brand marks fetched by website domain (Google favicon CDN),
// with a colored ticker-monogram fallback when offline or the logo is missing.

import { useState } from 'react'

const SECTOR_COLORS: Record<string, string> = {
  Energy: '#f59e0b', 'IT Services': '#6366f1', Banking: '#0ea5e9', FMCG: '#84cc16',
  Infrastructure: '#a855f7', NBFC: '#ec4899', Auto: '#ef4444', Pharma: '#14b8a6',
  Insurance: '#2ebd85',
}

/** Colored ticker monogram circle (fallback when no logo is available). */
export function Monogram({ symbol, sector, size = 26 }: { symbol: string; sector: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: SECTOR_COLORS[sector] ?? '#64748b', fontSize: size * 0.34 }}
    >
      {symbol.slice(0, 2)}
    </span>
  )
}

/** Real company logo by domain; falls back to the monogram on load failure. */
export function CompanyLogo({ domain, symbol, sector, size = 26 }: {
  domain?: string; symbol: string; sector: string; size?: number
}) {
  const [failed, setFailed] = useState(false)
  if (!domain || failed) return <Monogram symbol={symbol} sector={sector} size={size} />
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface ring-1 ring-[#ececf0]"
      style={{ width: size, height: size }}
    >
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
        alt={`${symbol} logo`}
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        loading="lazy"
        onError={() => setFailed(true)}
        className="rounded-sm object-contain"
      />
    </span>
  )
}
