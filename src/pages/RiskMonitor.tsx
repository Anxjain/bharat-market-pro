import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useWatchlist } from '../lib/watchlist'
import { useCompanyFeed, useUniverse } from '../lib/api'
import { companyBySymbol } from '../data/companies'
import { PageHeader, Disclaimer } from '../components/ui'
import { SeverityBadge } from '../components/badges'
import { DataSourceBadge } from '../components/DataSourceBadge'

const SEV_RANK: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 1, low: 2 }

/** One watchlist company's real, computed risk signals (own feed fetch). */
function WatchlistRiskCard({ symbol, name }: { symbol: string; name: string }) {
  const { feed, loading } = useCompanyFeed(symbol)
  const flags = [...(feed?.riskFlags ?? [])].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
  const top = flags[0]
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <Link to={`/company/${symbol}`} className="truncate text-[14px] font-bold text-ink hover:underline">{name}</Link>
        <span className="shrink-0 font-mono text-[10px] text-faint">{symbol}</span>
      </div>
      {loading && <p className="mt-2 text-[12px] italic text-faint">Computing risk signals…</p>}
      {!loading && top && (
        <span className="mt-1.5 inline-flex"><SeverityBadge severity={top.severity} /></span>
      )}
      <div className="mt-1">
        {!loading &&
          flags.map((f, i) => (
            <div key={i} className="mt-2 border-t border-line pt-2 first:mt-1.5 first:border-0 first:pt-0">
              <div className="flex items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{f.signal}</span>
              </div>
              <h4 className="mt-1 text-[13px] font-semibold leading-snug text-ink">{f.title}</h4>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{f.description}</p>
            </div>
          ))}
      </div>
    </div>
  )
}

export function RiskMonitor() {
  const { symbols } = useWatchlist()
  const { rows: universe } = useUniverse()
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()

  const nameFor = (s: string) =>
    companyBySymbol.get(s)?.name ?? universe.find((r) => r.symbol === s)?.name ?? s
  const filtered = symbols.filter((s) => !ql || s.toLowerCase().includes(ql) || nameFor(s).toLowerCase().includes(ql))

  return (
    <div>
      <PageHeader
        title="Risk Monitor"
        subtitle="Computed risk signals across your watchlist — from real price action and live disclosures"
        actions={<DataSourceBadge variant="live" label="Computed · live data" />}
      />

      {symbols.length === 0 ? (
        <div className="card py-14 text-center">
          <p className="text-[14px] font-semibold text-ink">Your watchlist is empty</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted">
            Add companies to your watchlist and their risk signals — price momentum, drawdowns, volatility, and
            disclosure patterns — appear here, computed from real data.
          </p>
          <Link to="/companies" className="btn mt-4">Browse companies</Link>
        </div>
      ) : (
        <>
          <div className="relative mb-5 w-full max-w-sm">
            <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter watchlist by company or symbol…"
              className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-3 text-[12.5px] shadow-sm focus:border-line focus:shadow-[0_2px_12px_rgba(16,24,40,0.07)] focus:outline-none"
            />
          </div>

          <div className="stagger grid gap-4 md:grid-cols-2">
            {filtered.map((s) => (
              <WatchlistRiskCard key={s} symbol={s} name={nameFor(s)} />
            ))}
          </div>
          {filtered.length === 0 && <p className="py-6 text-sm italic text-faint">No watchlist companies match “{q.trim()}”.</p>}

          <div className="mt-6 max-w-2xl">
            <Disclaimer />
          </div>
        </>
      )}
    </div>
  )
}
