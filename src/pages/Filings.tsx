import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Radio, ExternalLink, Sparkle, Search } from 'lucide-react'
import { useFilings } from '../lib/api'
import { timeAgo } from '../lib/format'
import { PageHeader, TabButton } from '../components/ui'
import { ExchangeBadge, MaterialityBadge } from '../components/badges'

export function Filings() {
  const { items, source, llmReady, loading } = useFilings()
  const [cat, setCat] = useState('All')
  const [highOnly, setHighOnly] = useState(false)
  const [q, setQ] = useState('')

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(items.map((f) => f.category))).sort()],
    [items],
  )

  const ql = q.trim().toLowerCase()
  let filtered = cat === 'All' ? items : items.filter((f) => f.category === cat)
  if (highOnly) filtered = filtered.filter((f) => f.materiality === 'high')
  if (ql) {
    filtered = filtered.filter(
      (f) =>
        f.company.toLowerCase().includes(ql) ||
        (f.symbol ?? '').toLowerCase().includes(ql) ||
        f.title.toLowerCase().includes(ql) ||
        (f.aiSummary ?? '').toLowerCase().includes(ql),
    )
  }
  filtered = [...filtered].sort((a, b) => b.filedAt.localeCompare(a.filedAt))

  return (
    <div>
      <PageHeader
        title="Filing Intelligence"
        subtitle={
          source === 'live'
            ? `Official NSE disclosure feeds — announcements, insider trades, board meetings, corporate actions, results${llmReady ? ' · AI digests by Groq' : ' · heuristic triage (add GROQ_API_KEY for AI digests)'}`
            : 'NSE & BSE corporate announcements with desk digests and materiality scoring'
        }
        actions={
          <span
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wide ${
              source === 'live' ? 'bg-up-soft text-up' : 'bg-panel text-muted'
            }`}
          >
            <Radio size={12} className={source === 'live' ? 'pulse-dot' : ''} />
            {loading ? 'Connecting…' : source === 'live' ? 'Live · NSE RSS' : 'Offline snapshot'}
          </span>
        }
      />

      {/* Section search — company, symbol or disclosure text */}
      <div className="relative mb-4 w-full max-w-sm">
        <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search filings by company or keyword — e.g. HDFC…"
          className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-3 text-[12.5px] shadow-sm focus:border-line focus:shadow-[0_2px_12px_rgba(16,24,40,0.07)] focus:outline-none"
        />
      </div>
      {ql && <p className="mb-3 text-[11px] font-semibold text-faint">{filtered.length} filings match “{q.trim()}”</p>}

      <div className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-2 border-b rule">
        {categories.map((c) => (
          <TabButton key={c} active={cat === c} onClick={() => setCat(c)}>{c}</TabButton>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">
          <input
            type="checkbox"
            checked={highOnly}
            onChange={(e) => setHighOnly(e.target.checked)}
            className="accent-[#e1404f]"
          />
          High materiality only
        </label>
      </div>

      <div className="stagger max-w-4xl">
        {filtered.length === 0 && (
          <p className="py-10 text-center text-sm italic text-faint">No filings match the filter.</p>
        )}
        {filtered.slice(0, 60).map((f) => (
          <article key={f.id} className="border-b rule py-5 first:pt-1 last:border-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <ExchangeBadge exchange={f.exchange} />
              {f.symbol ? (
                <Link to={`/company/${f.symbol}`} className="text-[12.5px] font-semibold text-sky-800 hover:underline">
                  {f.company}
                </Link>
              ) : (
                <span className="text-[12.5px] font-semibold text-strong">{f.company}</span>
              )}
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{f.category}</span>
              <span className="ml-auto"><MaterialityBadge materiality={f.materiality} /></span>
            </div>
            <h3 className="mt-2 max-w-2xl text-[14px] font-medium leading-snug text-strong">
              {f.link ? <a href={f.link} target="_blank" rel="noreferrer" className="hover:text-sky-800 hover:underline">{f.title}</a> : f.title}
            </h3>
            {f.aiSummary && (
              <p className="mt-2 flex max-w-2xl items-start gap-2 rounded-xl bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-muted">
                {f.ai && <Sparkle size={13} className="mt-0.5 shrink-0 text-up" />}
                <span><b className="text-strong">Digest:</b> {f.aiSummary}</span>
              </p>
            )}
            <div className="mt-2 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
              <span>Filed {timeAgo(f.filedAt, source === 'live' ? new Date() : undefined)}</span>
              {f.link && (
                <a href={f.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sky-800 hover:underline">
                  Source PDF <ExternalLink size={10} />
                </a>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
