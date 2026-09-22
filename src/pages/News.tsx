import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Radio, Landmark, ExternalLink, Search } from 'lucide-react'
import { type Sentiment } from '../data/news'
import { useNews } from '../lib/api'
import { timeAgo } from '../lib/format'
import { PageHeader, SectionTitle, TabButton } from '../components/ui'
import { SentimentBadge } from '../components/badges'
import { SentimentBar } from '../components/charts'

const filters: ('all' | Sentiment)[] = ['all', 'positive', 'neutral', 'negative']

export function News() {
  const [filter, setFilter] = useState<(typeof filters)[number]>('all')
  const [q, setQ] = useState('')
  const { items: allItems, source, feeds, updatedAt, loading } = useNews()

  // Company/keyword search applies to BOTH the exchange wire and press stories
  const ql = q.trim().toLowerCase()
  const matchesQ = (n: (typeof allItems)[number]) =>
    !ql ||
    n.headline.toLowerCase().includes(ql) ||
    n.summary.toLowerCase().includes(ql) ||
    n.source.toLowerCase().includes(ql) ||
    n.tickers.some((t) => t.toLowerCase().includes(ql))

  // Exchange wire (NSE/BSE primary disclosures) pinned on top; press below
  const wire = useMemo(() => allItems.filter((n) => n.tier === 'exchange' && matchesQ(n)).slice(0, 8), [allItems, ql]) // eslint-disable-line react-hooks/exhaustive-deps
  const press = useMemo(() => allItems.filter((n) => n.tier !== 'exchange' && matchesQ(n)), [allItems, ql]) // eslint-disable-line react-hooks/exhaustive-deps

  const breakdown = useMemo(
    () => ({
      positive: press.filter((n) => n.sentiment === 'positive').length,
      neutral: press.filter((n) => n.sentiment === 'neutral').length,
      negative: press.filter((n) => n.sentiment === 'negative').length,
    }),
    [press],
  )
  const items = filter === 'all' ? press : press.filter((n) => n.sentiment === filter)
  const now = source === 'live' ? new Date() : undefined

  return (
    <div>
      <PageHeader
        title="News Intelligence"
        subtitle={
          source === 'live'
            ? `Exchange wire first, then ${feeds.length} press desks (${feeds.join(', ')}) · auto-refreshes every 2 min`
            : 'Aggregated Indian business press with sentiment tagging'
        }
        actions={
          <span
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wide ${
              source === 'live' ? 'bg-up-soft text-up' : 'bg-panel text-muted'
            }`}
          >
            <Radio size={12} className={source === 'live' ? 'pulse-dot' : ''} />
            {loading ? 'Connecting…' : source === 'live' ? `Live · updated ${updatedAt ? updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'now'}` : 'Offline snapshot'}
          </span>
        }
      />

      <div className="grid gap-10 xl:grid-cols-12">
        <div className="xl:col-span-8">
          {/* Section search — filters the wire AND the press list */}
          <div className="relative mb-4 w-full max-w-sm">
            <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search news by company or keyword — e.g. HDFC…"
              className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-3 text-[12.5px] shadow-sm focus:border-line focus:shadow-[0_2px_12px_rgba(16,24,40,0.07)] focus:outline-none"
            />
          </div>
          {ql && (
            <p className="mb-3 text-[11px] font-semibold text-faint">
              {wire.length + press.length} results for “{q.trim()}” — exchange wire + press
            </p>
          )}

          {/* Exchange wire — NSE/BSE primary disclosures take priority */}
          {wire.length > 0 && (
            <div className="card mb-6 overflow-hidden p-0">
              <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
                <Landmark size={13} className="text-ink" />
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink">Exchange wire</span>
                <span className="text-[10px] font-semibold text-faint">NSE primary disclosures · materiality-filtered</span>
              </div>
              <div className="divide-y divide-[#f4f5f7]">
                {wire.map((n) => (
                  <div key={n.id} className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {n.link ? (
                          <a href={n.link} target="_blank" rel="noreferrer" className="text-[12.5px] font-bold text-strong hover:text-sky-800 hover:underline">
                            {n.headline}
                          </a>
                        ) : (
                          <span className="text-[12.5px] font-bold text-strong">{n.headline}</span>
                        )}
                        {n.tickers[0] && (
                          <Link to={`/company/${n.tickers[0]}`} className="rounded bg-panel px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-sky-800 hover:bg-info-soft">
                            {n.tickers[0]}
                          </Link>
                        )}
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{timeAgo(n.publishedAt, now)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-muted">{n.summary}</p>
                    </div>
                    {n.link && (
                      <a href={n.link} target="_blank" rel="noreferrer" className="mt-1 shrink-0 text-faint transition-colors hover:text-sky-700" title="Source PDF">
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-5 flex gap-6 border-b rule">
            {filters.map((f) => (
              <TabButton key={f} active={filter === f} onClick={() => setFilter(f)}>{f}</TabButton>
            ))}
          </div>

          <div className="stagger">
            {items.map((n) => (
              <article key={n.id} className="border-b rule py-5 first:pt-1 last:border-0">
                <div className="flex items-baseline justify-between gap-4">
                  <SentimentBadge sentiment={n.sentiment} />
                  <span className="font-mono text-[10px] text-faint">{n.sentimentScore > 0 ? '+' : ''}{n.sentimentScore.toFixed(2)}</span>
                </div>
                <h3 className="mt-2 max-w-2xl text-[18px] font-medium leading-snug text-ink">
                  {n.link ? (
                    <a href={n.link} target="_blank" rel="noreferrer" className="hover:underline">{n.headline}</a>
                  ) : (
                    n.headline
                  )}
                </h3>
                <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{n.summary}</p>
                <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                  <span>{n.source}</span>
                  <span className="text-faint">/</span>
                  <span>{timeAgo(n.publishedAt, now)}</span>
                  {n.tickers.length > 0 && <span className="text-faint">/</span>}
                  {n.tickers.map((t) => (
                    <Link key={t} to={`/company/${t}`} className="font-mono tracking-[0.08em] text-sky-800 hover:underline">
                      {t}
                    </Link>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="border-t border-line pt-5 xl:col-span-4 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0 xl:[border-left-color:#ececf0]">
          <SectionTitle>Sentiment mix — press</SectionTitle>
          <SentimentBar positive={breakdown.positive} neutral={breakdown.neutral} negative={breakdown.negative} />
          <p className="mt-5 border-t border-dashed rule pt-3 text-[11.5px] italic leading-relaxed text-faint">
            {source === 'live'
              ? `${press.length} press stories + ${wire.length} exchange disclosures. Server refreshes feeds every 5 minutes; this page re-polls every 2. Sentiment is screened automatically on ingestion.`
              : 'Sentiment is rule-tagged in the prototype; a model-based classifier replaces it over live feeds.'}
          </p>
        </div>
      </div>
    </div>
  )
}
