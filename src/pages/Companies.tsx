import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { companies } from '../data/companies'
import { useUniverse } from '../lib/api'
import { CompanyCard } from '../components/CompanyCard'
import { CompanyLogo } from '../components/Logo'
import { PageHeader, SectionTitle, TabButton } from '../components/ui'
import { UP, DOWN } from '../components/CandleChart'

const sectors = ['All', ...Array.from(new Set(companies.map((c) => c.sector)))]

export function Companies() {
  // Deep-linkable and drift-free: the URL is the single source of truth for BOTH the
  // curated sector filter and the directory industry filter, so the terminal's sector
  // tape (?sector= / ?industry=) works whether or not the page is already open.
  const [searchParams, setSearchParams] = useSearchParams()
  const sectorParam = searchParams.get('sector')
  const sector = sectorParam && sectors.includes(sectorParam) ? sectorParam : 'All'
  const industry = searchParams.get('industry') ?? 'All'
  const filtered = sector === 'All' ? companies : companies.filter((c) => c.sector === sector)

  // Full NIFTY 500 directory (real EOD closes from the price store)
  const { rows: universe, asOf, loading } = useUniverse()
  const [q, setQ] = useState('')
  const industries = useMemo(
    () => ['All', ...Array.from(new Set(universe.map((r) => r.industry))).sort()],
    [universe],
  )
  const dirRows = useMemo(() => {
    const ql = q.toLowerCase()
    return universe
      .filter((r) => industry === 'All' || r.industry === industry)
      .filter((r) => !ql || r.symbol.toLowerCase().includes(ql) || r.name.toLowerCase().includes(ql))
  }, [universe, q, industry])

  function setParam(key: 'sector' | 'industry', value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === 'All') next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }
  const pick = (s: string) => setParam('sector', s)

  return (
    <div>
      <PageHeader
        title="Company Directory"
        subtitle={`${universe.length || companies.length} companies — ${companies.length} with curated deep coverage, full NIFTY 500 with real NSE prices`}
      />

      {/* Curated coverage cards */}
      <SectionTitle>Curated coverage</SectionTitle>
      <div className="mb-4 flex flex-wrap gap-2">
        {sectors.map((s) => (
          <TabButton key={s} active={sector === s} onClick={() => pick(s)}>{s}</TabButton>
        ))}
      </div>
      <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {filtered.map((c) => (
          <CompanyCard key={c.symbol} company={c} />
        ))}
      </div>

      {/* Full NIFTY 500 directory */}
      <div className="mt-10">
        <SectionTitle
          right={
            asOf ? (
              <span className="rounded-full bg-up-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-up">
                NSE EOD · as of {asOf}
              </span>
            ) : undefined
          }
        >
          NIFTY 500 directory
        </SectionTitle>

        {loading && <p className="py-6 text-sm italic text-faint">Loading the universe…</p>}
        {!loading && universe.length === 0 && (
          <p className="py-6 text-sm italic text-faint">
            Universe unavailable — start the API server and run <code>npm run ingest</code> in <code>server/</code>.
          </p>
        )}

        {universe.length > 0 && (
          <div className="card overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-line p-3.5">
              <div className="relative w-72">
                <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter by name or symbol…"
                  className="w-full rounded-full border border-line bg-panel py-1.5 pl-9 pr-3 text-[12.5px] focus:border-line focus:bg-surface focus:outline-none"
                />
              </div>
              <select
                value={industry}
                onChange={(e) => setParam('industry', e.target.value)}
                className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-muted focus:outline-none"
              >
                {industries.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
              <span className="ml-auto text-[11px] font-semibold text-faint">{dirRows.length} companies</span>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-surface shadow-[0_1px_0_#f0f1f4]">
                  <tr className="text-left text-[10px] uppercase tracking-wide text-faint">
                    <th className="px-4 py-2.5 font-bold">Symbol</th>
                    <th className="px-2 py-2.5 font-bold">Company</th>
                    <th className="px-2 py-2.5 font-bold">Industry</th>
                    <th className="px-2 py-2.5 text-right font-bold">Close ₹</th>
                    <th className="px-4 py-2.5 text-right font-bold">Day</th>
                  </tr>
                </thead>
                <tbody>
                  {dirRows.map((r) => (
                    <tr key={r.symbol} className="border-t border-line transition-colors hover:bg-panel">
                      <td className="px-4 py-2">
                        <Link to={`/company/${r.symbol}`} className="flex items-center gap-2 font-mono text-[11.5px] font-bold text-sky-800 hover:underline">
                          <CompanyLogo domain={r.domain ?? undefined} symbol={r.symbol} sector={r.industry} size={20} />
                          {r.symbol}
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        <Link to={`/company/${r.symbol}`} className="font-medium text-strong hover:text-ink">
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-[11px] text-faint">{r.industry}</td>
                      <td className="px-2 py-2 text-right font-mono font-medium text-ink">
                        {r.close != null ? r.close.toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-semibold" style={{ color: (r.changePct ?? 0) >= 0 ? UP : DOWN }}>
                        {r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
