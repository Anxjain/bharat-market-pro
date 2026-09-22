import { useMemo, useState } from 'react'
import { companies } from '../data/companies'
import { useWatchlist } from '../lib/watchlist'
import { useUniverse } from '../lib/api'
import { buildCompanyBrief, buildWatchlistBrief, downloadMarkdown } from '../lib/report'
import { PageHeader, SectionTitle } from '../components/ui'
import { MarkdownLite } from '../components/MarkdownLite'

type ReportKind = 'watchlist' | 'company'

export function Reports() {
  const { symbols } = useWatchlist()
  const { rows: universe } = useUniverse()
  const [kind, setKind] = useState<ReportKind>('watchlist')
  const [companySymbol, setCompanySymbol] = useState(companies[0].symbol)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Company picker spans the full NIFTY 500 universe (falls back to curated set).
  const pickList = useMemo(() => {
    if (universe.length) return universe.map((r) => ({ symbol: r.symbol, name: r.name }))
    return companies.map((c) => ({ symbol: c.symbol, name: c.name }))
  }, [universe])

  async function generate() {
    setBusy(true)
    setReport(null)
    try {
      const md = kind === 'watchlist' ? await buildWatchlistBrief(symbols) : await buildCompanyBrief(companySymbol)
      setReport(md)
    } finally {
      setBusy(false)
    }
  }

  const filename =
    kind === 'watchlist' ? 'daily-watchlist-brief.md' : `${companySymbol}-research-brief.md`

  const kinds: { key: ReportKind; title: string; desc: string }[] = [
    { key: 'watchlist', title: 'Daily Watchlist Brief', desc: `${symbols.length} companies on your watchlist` },
    { key: 'company', title: 'Company Research Brief', desc: 'Deep-dive on a single company' },
  ]

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Analyst-style briefs built from live data — export as Markdown or print to PDF"
      />

      <div className="no-print grid gap-10 xl:grid-cols-12">
        <div className="xl:col-span-4">
          <SectionTitle>Report type</SectionTitle>
          <div>
            {kinds.map((k) => (
              <button
                key={k.key}
                onClick={() => { setKind(k.key); setReport(null) }}
                className="group flex w-full items-baseline gap-3 border-b rule py-3.5 text-left transition-colors"
              >
                <span className={`text-[11px] ${kind === k.key ? 'text-down' : 'text-faint'}`}>
                  {kind === k.key ? '■' : '□'}
                </span>
                <span>
                  <span className={`block text-[16px] font-medium ${kind === k.key ? 'text-ink' : 'text-muted group-hover:text-strong'}`}>
                    {k.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-faint">{k.desc}</span>
                </span>
              </button>
            ))}
          </div>

          {kind === 'company' && (
            <div className="mt-5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Company</label>
              <select
                value={companySymbol}
                onChange={(e) => { setCompanySymbol(e.target.value); setReport(null) }}
                className="mt-2 w-full border-b border-line bg-transparent pb-1.5 text-[13.5px] text-strong focus:border-inkfill focus:outline-none"
              >
                {pickList.map((c) => (
                  <option key={c.symbol} value={c.symbol}>{c.name} ({c.symbol})</option>
                ))}
              </select>
            </div>
          )}

          <button onClick={generate} disabled={busy} className="btn btn-fill mt-7 w-full justify-center disabled:opacity-50">
            {busy ? 'Composing…' : 'Compose report'}
          </button>

          {report && (
            <div className="mt-3 flex gap-2.5">
              <button onClick={() => downloadMarkdown(filename, report)} className="btn flex-1 justify-center">
                Markdown ↓
              </button>
              <button onClick={() => window.print()} className="btn flex-1 justify-center">
                Print / PDF
              </button>
            </div>
          )}
        </div>

        <div className="xl:col-span-8">
          {report ? (
            <div className="max-h-[74vh] overflow-y-auto rounded-2xl border border-line bg-surface shadow-sm px-1 py-5">
              <MarkdownLite text={report} />
            </div>
          ) : (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center rounded-2xl border border-line bg-surface shadow-sm text-center">
              <p className="text-[15px] italic text-muted">{busy ? 'Composing from live data…' : 'Compose a report to preview it here.'}</p>
              <p className="mt-1.5 text-[11px] text-faint">Briefs pull live prices, fundamentals, news, filings and risk signals.</p>
            </div>
          )}
        </div>
      </div>

      {/* Print-only clean rendering */}
      {report && (
        <div className="print-area hidden">
          <MarkdownLite text={report} />
        </div>
      )}
    </div>
  )
}
