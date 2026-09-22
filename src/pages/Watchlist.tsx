import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { companyBySymbol, type Company } from '../data/companies'
import { useWatchlist } from '../lib/watchlist'
import { useUniverse } from '../lib/api'
import { CompanyCard } from '../components/CompanyCard'
import { Monogram } from '../components/Logo'
import { PageHeader } from '../components/ui'
import { RuleAlerts } from '../components/RuleAlerts'
import { DataSourceBadge } from '../components/DataSourceBadge'
import { formatPct, changeColor } from '../lib/format'
import { UP, DOWN } from '../components/CandleChart'

export function Watchlist() {
  const { symbols, toggle, synced } = useWatchlist()
  const list = symbols.map((s) => companyBySymbol.get(s)).filter((c): c is Company => !!c)
  // NIFTY 500 symbols outside the curated set — shown as rows with real closes
  const { rows: universe } = useUniverse()
  const others = symbols
    .filter((s) => !companyBySymbol.has(s))
    .map((s) => universe.find((r) => r.symbol === s))
    .filter((r): r is NonNullable<typeof r> => !!r)

  // Aggregate from REAL day-change across the whole watchlist (universe-backed).
  const realChanges = symbols
    .map((s) => universe.find((r) => r.symbol === s)?.changePct)
    .filter((v): v is number => v != null)
  const avgChange = realChanges.length ? realChanges.reduce((a, b) => a + b, 0) / realChanges.length : null

  return (
    <div>
      <PageHeader
        title="Watchlist"
        subtitle={synced ? 'Your tracked companies — synced to your account' : 'Your tracked companies — saved in this browser (sign in via the profile menu to sync)'}
        actions={
          <Link to="/reports" className="btn btn-red">Generate watchlist brief</Link>
        }
      />

      {symbols.length > 0 && (
        <div className="mb-8 flex max-w-md items-stretch divide-x divide-[#ececf0] rounded-2xl border border-line bg-surface shadow-sm">
          <div className="flex-1 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Avg day change</span>
              {avgChange != null && <DataSourceBadge variant="live" />}
            </div>
            <div className={`mt-1 text-[20px] font-medium leading-none ${avgChange != null ? changeColor(avgChange) : 'text-faint'}`}>
              {avgChange != null ? formatPct(avgChange) : '—'}
            </div>
          </div>
          <div className="flex-1 px-5 py-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Companies tracked</div>
            <div className="mt-1 text-[20px] font-medium leading-none text-ink">{symbols.length}</div>
          </div>
        </div>
      )}

      {list.length === 0 && others.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-[15px] italic text-muted">Your watchlist is empty.</p>
          <Link to="/companies" className="btn mt-4">Browse companies</Link>
        </div>
      ) : (
        <>
          <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((c) => (
              <CompanyCard key={c.symbol} company={c} />
            ))}
          </div>

          {others.length > 0 && (
            <div className="card mt-6 overflow-hidden p-0">
              <div className="border-b border-line bg-panel px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                Also watching — NIFTY 500 (real NSE closes)
              </div>
              <div className="divide-y divide-[#f4f5f7]">
                {others.map((r) => (
                  <div key={r.symbol} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface">
                    <Monogram symbol={r.symbol} sector={r.industry} size={24} />
                    <Link to={`/company/${r.symbol}`} className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-ink hover:underline">{r.name}</span>
                      <span className="block text-[10.5px] text-faint">{r.symbol} · {r.industry}</span>
                    </Link>
                    <span className="text-right">
                      <span className="block font-mono text-[12.5px] font-semibold text-ink">
                        {r.close != null ? `₹${r.close.toLocaleString('en-IN')}` : '—'}
                      </span>
                      <span className="block text-[10.5px] font-bold" style={{ color: (r.changePct ?? 0) >= 0 ? UP : DOWN }}>
                        {r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => toggle(r.symbol)}
                      title={`Remove ${r.symbol}`}
                      className="ml-2 flex h-6 w-6 items-center justify-center rounded-full text-faint transition-colors hover:bg-down-soft hover:text-down"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Rule-based alerts (9.7) — screen the whole universe or the watchlist on
          price/volume/news/filing conditions; hits are stored and emailed. */}
      <div className="mt-8">
        <RuleAlerts />
      </div>
    </div>
  )
}
