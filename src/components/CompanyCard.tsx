import { Link } from 'react-router-dom'
import { Star } from 'lucide-react'
import type { Company } from '../data/companies'
import { lastN } from '../data/series'
import { useWatchlist } from '../lib/watchlist'
import { formatINR } from '../lib/format'
import { ChangePill } from './badges'
import { Sparkline } from './charts'
import { CompanyLogo } from './Logo'
import { useUniverse } from '../lib/api'

export function CompanyCard({ company }: { company: Company }) {
  const { has, toggle } = useWatchlist()
  const watched = has(company.symbol)
  // Real NSE EOD close replaces the curated mock price when the store answers
  const { rows } = useUniverse()
  const real = rows.find((r) => r.symbol === company.symbol)
  const price = real?.close ?? company.price
  const changePct = real?.changePct ?? company.dayChangePct

  return (
    <div className="card card-hover p-4">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/company/${company.symbol}`} className="flex min-w-0 items-center gap-2.5">
          <CompanyLogo domain={company.domain} symbol={company.symbol} sector={company.sector} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-bold leading-tight text-ink">{company.name}</span>
            <span className="mt-0.5 block text-[10.5px] leading-tight text-faint">
              <span className="font-mono font-semibold text-muted">{company.symbol}</span> · {company.sector}
            </span>
          </span>
        </Link>
        <button
          onClick={() => toggle(company.symbol)}
          title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
          className={`rounded-full p-1.5 transition-all duration-200 hover:scale-110 ${watched ? 'text-[#f0a30e]' : 'text-faint hover:text-muted'}`}
        >
          <Star size={15} className={watched ? 'fill-[#f0a30e]' : ''} />
        </button>
      </div>

      <div className="mt-3.5 flex items-end justify-between">
        <div>
          <div className="text-[18px] font-bold tracking-tight text-ink">{formatINR(price)}</div>
          <div className="mt-1 flex items-center gap-2">
            <ChangePill value={changePct} />
            {real && <span className="text-[9px] font-bold uppercase tracking-wide text-faint">NSE EOD</span>}
          </div>
        </div>
        <div className="w-28">
          <Sparkline data={lastN(company.history, 30)} positive={changePct >= 0} />
        </div>
      </div>
    </div>
  )
}
