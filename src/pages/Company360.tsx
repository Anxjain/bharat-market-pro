// Company 360 — IDENTICAL treatment for every NIFTY 500 company:
// live quote + real candles, AI desk note, company chat, and five dossier tabs
// (News / Announcements / Corporate actions / Filings / Risk flags), all fed by
// real data with honest fallbacks — no section is ever blank.

import { useParams, Link } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Sparkle } from 'lucide-react'
import { useCandles, useQuotes, useCompanyFeed, useAlerts, useFactSheet, useInsurerKpis } from '../lib/api'
import { TradingChart } from '../components/TradingChart'
import { AlertPanel } from '../components/AlertPanel'
import { companyBySymbol } from '../data/companies'
import { buildCompanyBrief, downloadMarkdown } from '../lib/report'
import { useWatchlist } from '../lib/watchlist'
import { formatINR, formatPct, timeAgo } from '../lib/format'
import { PageHeader, SectionTitle, Stat, TabButton, Disclaimer } from '../components/ui'
import { ExchangeBadge, MaterialityBadge, SentimentBadge, SeverityBadge } from '../components/badges'
import { DataSourceBadge } from '../components/DataSourceBadge'
import { UP, DOWN } from '../components/CandleChart'
import { CompanyLogo } from '../components/Logo'
import { CompanyChat } from '../components/CompanyChat'
import { deriveCandles } from '../data/series'

type Tab = 'facts' | 'news' | 'announcements' | 'actions' | 'filings' | 'risk'

const FILING_CATEGORIES = ['Financial Results', 'Board Meeting', 'Investor Presentation', 'Credit Rating']

// "Explain this move" (9.4) — one click assembles the grounded causal story for the
// day's move (price + filings + news + corp actions → ≤3-sentence narrative).
interface Explanation {
  date: string
  movePct: number
  indexMovePct: number | null
  narrative: string
  source: 'llm' | 'stats'
  evidence: {
    filings: { date: string; title: string; link: string | null }[]
    news: { date: string; headline: string; source: string }[]
    corpActions: { date: string; type: string; detail: string }[]
  }
}

function ExplainMove({ sym }: { sym: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'open' | 'error'>('idle')
  const [exp, setExp] = useState<Explanation | null>(null)
  // Track the live symbol so a slow fetch that resolves AFTER the user navigated to
  // another company doesn't pop the old company's explanation onto the new page.
  const symRef = useRef(sym)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when the symbol changes
  useEffect(() => { symRef.current = sym; setState('idle'); setExp(null) }, [sym])

  const load = async () => {
    if (state === 'open') { setState('idle'); return }
    setState('loading')
    try {
      const r = await fetch(`/api/explain/${encodeURIComponent(sym)}`, { signal: AbortSignal.timeout(45_000) })
      if (!r.ok) throw new Error(String(r.status))
      const data = (await r.json()) as Explanation
      if (symRef.current !== sym) return // navigated away — drop the stale result
      setExp(data)
      setState('open')
    } catch {
      if (symRef.current === sym) setState('error')
    }
  }

  return (
    <>
      <button onClick={load} disabled={state === 'loading'} className="inline-flex items-center gap-1 rounded-full bg-panel px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-inkfill hover:text-white disabled:opacity-50">
        <Sparkle size={11} /> {state === 'loading' ? 'Reading the tape…' : state === 'open' ? 'Hide' : 'Why this move?'}
      </button>
      {state === 'error' && <span className="text-[11px] text-faint">explanation unavailable</span>}
      {state === 'open' && exp && (
        <div className="w-full rounded-lg bg-panel/60 px-3 py-2.5">
          <p className="text-[12.5px] leading-relaxed text-ink">{exp.narrative}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
            <span>{exp.date} · stock {formatPct(exp.movePct)}{exp.indexMovePct != null ? ` · NIFTY ${formatPct(exp.indexMovePct)}` : ''}</span>
            <span className="rounded-full bg-surface px-1.5 py-0.5 font-semibold uppercase">{exp.source === 'llm' ? 'AI, evidence-grounded' : 'from the data'}</span>
          </div>
          {(exp.evidence.filings.length > 0 || exp.evidence.news.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {exp.evidence.filings.slice(0, 3).map((f, i) =>
                f.link ? (
                  <a key={`f${i}`} href={f.link} target="_blank" rel="noreferrer" className="max-w-72 truncate rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] text-sky-800 hover:underline" title={f.title}>filing {f.date}: {f.title}</a>
                ) : (
                  <span key={`f${i}`} className="max-w-72 truncate rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] text-muted" title={f.title}>filing {f.date}: {f.title}</span>
                ),
              )}
              {exp.evidence.news.slice(0, 3).map((n, i) => (
                <span key={`n${i}`} className="max-w-72 truncate rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] text-muted" title={n.headline}>{n.source} {n.date}: {n.headline}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function EmptyNote({ what, sym }: { what: string; sym: string }) {
  const nseLink = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(sym)}`
  return (
    <p className="py-6 text-[13px] italic text-faint">
      No {what} for {sym} in our live window yet (the store accumulates from June 2026 onward).{' '}
      <a href={nseLink} target="_blank" rel="noreferrer" className="not-italic text-sky-800 hover:underline">
        Full history on NSE →
      </a>
    </p>
  )
}

export function Company360() {
  const { symbol } = useParams()
  const sym = symbol?.toUpperCase() ?? ''
  const curated = companyBySymbol.get(sym)
  const { has, toggle } = useWatchlist()
  const [tab, setTab] = useState<Tab>('facts')
  const [briefBusy, setBriefBusy] = useState(false)

  const mockCandles = useMemo(() => (curated ? deriveCandles(curated.symbol, curated.history) : []), [curated])
  const { candles, source: priceSource } = useCandles('equity', sym, mockCandles)
  const quotes = useQuotes([sym])
  const live = quotes.get(sym)
  const { feed, loading: feedLoading } = useCompanyFeed(sym)
  const { active: activeAlerts, refresh: refreshAlerts } = useAlerts(sym)
  const { sheet, loading: sheetLoading } = useFactSheet(sym)

  // Memoized so TradingChart's alert-levels effect doesn't churn each render.
  const chartLevels = useMemo(
    () =>
      activeAlerts
        .filter((a) => a.active)
        .map((a) => ({ price: a.price, title: `alert ${a.condition === 'above' ? '≥' : '≤'}` })),
    [activeAlerts],
  )

  // Real risk summary from the computed signal flags (highest severity + headline)
  const riskSummary = useMemo(() => {
    const flags = feed?.riskFlags ?? []
    if (flags.length === 0) return null
    const severity = flags.some((f) => f.severity === 'high')
      ? ('high' as const)
      : flags.some((f) => f.severity === 'medium')
        ? ('medium' as const)
        : ('low' as const)
    const top = flags.find((f) => f.severity === severity) ?? flags[0]
    const more = flags.length > 1 ? ` (+${flags.length - 1} more)` : ''
    return { severity, text: `${top.title}${more}` }
  }, [feed])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional tab reset when the symbol changes
  useEffect(() => setTab('facts'), [sym])

  const name = feed?.name ?? curated?.name ?? sym
  const industry = feed?.industry ?? curated?.industry ?? ''
  const watched = has(sym)
  const lastEod = candles[candles.length - 1]
  const headerPrice = live?.price ?? lastEod?.c ?? curated?.price ?? 0
  const headerChange = live?.changePct ?? curated?.dayChangePct ?? 0
  const { bySymbol: kpiBySymbol } = useInsurerKpis()
  const ins = kpiBySymbol(sym)

  // Real stats from candles for the right card (all companies)
  const stats = useMemo(() => {
    if (candles.length < 6) return null
    const closes = candles.map((c) => c.c)
    const last = closes[closes.length - 1]
    const pct = (bars: number) => (closes.length > bars ? ((last - closes[closes.length - 1 - bars]) / closes[closes.length - 1 - bars]) * 100 : 0)
    // 3M ≈ 63 sessions; fall back to the whole loaded window with an honest label.
    const has3M = closes.length >= 64
    return {
      hi: Math.max(...candles.map((c) => c.h)),
      lo: Math.min(...candles.map((c) => c.l)),
      avgVolM: candles.reduce((a, c) => a + c.v, 0) / candles.length / 1e6,
      w1: pct(5),
      m1: pct(21),
      m3: has3M ? pct(63) : pct(closes.length - 1),
      m3Label: has3M ? '3M move' : `${closes.length - 1}d move`,
    }
  }, [candles])

  if (!curated && !feed && !feedLoading) {
    return (
      <div className="py-16 text-center">
        <p className="italic text-muted">{sym || 'This symbol'} is not in the NIFTY 500 universe — check the spelling or browse the directory.</p>
        <Link to="/companies" className="btn mt-4">Browse companies</Link>
      </div>
    )
  }

  const priceBadge = live
    ? { cls: 'bg-info-soft text-[#2186c4]', text: `Delayed live · ${live.marketTime ? new Date(live.marketTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'today'}` }
    : priceSource === 'live'
      ? { cls: 'bg-up-soft text-up', text: `NSE EOD · as of ${lastEod?.date}` }
      : { cls: 'bg-panel text-faint', text: 'Loading…' }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'facts', label: 'Fact sheet', count: sheet?.ratios.length ?? 0 },
    { key: 'news', label: 'News', count: feed?.news.length ?? 0 },
    { key: 'announcements', label: 'Announcements', count: feed?.announcements.filter((f) => !FILING_CATEGORIES.includes(f.category)).length ?? 0 },
    { key: 'actions', label: 'Corporate actions', count: feed?.corporateActions.length ?? 0 },
    { key: 'filings', label: 'Filings', count: feed?.announcements.filter((f) => FILING_CATEGORIES.includes(f.category)).length ?? 0 },
    { key: 'risk', label: 'Risk flags', count: feed?.riskFlags.length ?? 0 },
  ]

  const announcements = feed?.announcements.filter((f) => !FILING_CATEGORIES.includes(f.category)) ?? []
  // Press coverage of corporate events — gives the tabs month-deep history even
  // where the exchange-disclosure store is still young
  const EVENT_RE = /dividend|results?|profit|revenue|earnings|order|contract|acquisi|merger|demerger|stake|buyback|bonus|split|board|approval|expansion|plant|capacity|launch|agreement|partnership|fund ?rais|qip|ipo|rating/i
  const RESULTS_RE = /results?|profit|revenue|earnings|q[1-4]\b|quarter|margin/i
  const eventCoverage = (feed?.news ?? []).filter((n) => EVENT_RE.test(n.headline)).slice(0, 14)
  const resultsCoverage = (feed?.news ?? []).filter((n) => RESULTS_RE.test(n.headline)).slice(0, 10)
  const filingItems = feed?.announcements.filter((f) => FILING_CATEGORIES.includes(f.category)) ?? []

  return (
    <div>
      <PageHeader
        title={name}
        subtitle={`${sym} · ${industry}${curated ? ` · Listed ${curated.exchanges.join(' / ')}` : ' · NIFTY 500'}`}
        actions={
          <div className="flex gap-2.5">
            <button onClick={() => toggle(sym)} className={watched ? 'btn-red btn' : 'btn'}>
              {watched ? '★ Watching' : '☆ Watch'}
            </button>
            <button
              onClick={async () => {
                if (briefBusy) return
                setBriefBusy(true)
                try {
                  downloadMarkdown(`${sym}-research-brief.md`, await buildCompanyBrief(sym))
                } finally {
                  setBriefBusy(false)
                }
              }}
              disabled={briefBusy}
              className="btn disabled:opacity-50"
            >
              {briefBusy ? 'Composing…' : 'Research brief ↓'}
            </button>
          </div>
        }
      />

      {/* items-start: the chart card keeps a fixed terminal-like height instead of
          stretching to match the (taller) right column — no white gap, no giant chart. */}
      <div className="grid items-start gap-4 xl:grid-cols-12">
        {/* Chart */}
        <div className="card p-4 xl:col-span-8">
          <div className="flex flex-wrap items-center gap-3 px-1 pb-2">
            <CompanyLogo domain={curated?.domain ?? feed?.domain ?? sheet?.domain ?? undefined} symbol={sym} sector={curated?.sector ?? industry} size={28} />
            <span className="text-[26px] font-bold leading-none tracking-tight text-ink">{formatINR(headerPrice)}</span>
            <span className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: headerChange >= 0 ? '#e7f8f1' : '#fdeef0', color: headerChange >= 0 ? UP : DOWN }}>
              {formatPct(headerChange)}
            </span>
            <ExplainMove sym={sym} />
            <span className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${priceBadge.cls}`}>
              {priceBadge.text}
            </span>
          </div>
          <TradingChart
            data={candles}
            symbol={sym}
            height={440}
            levels={chartLevels}
          />
        </div>

        {/* Right column: real fundamentals + trading stats + risk + price alerts */}
        <div className="space-y-4 xl:col-span-4">
        <div className="card p-5">
          {/* Key fundamentals — real screener.in ratios for any NIFTY 500 symbol */}
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Key fundamentals</SectionTitle>
            {sheet && <DataSourceBadge variant="live" label="screener.in" />}
          </div>
          {sheetLoading && <p className="text-[12px] text-faint">Fetching fundamentals…</p>}
          {!sheetLoading && !sheet && (
            <p className="text-[12px] text-faint">Fundamentals unavailable — check the Fact sheet tab.</p>
          )}
          {sheet && (
            <div className="grid grid-cols-2 gap-2">
              {sheet.ratios.slice(0, 8).map((r) => (
                <Stat key={r.label} label={r.label} value={r.value} />
              ))}
            </div>
          )}

          {/* Trading stats — real, computed from NSE EOD candles */}
          <div className="mt-4 border-t border-line pt-3">
            <SectionTitle>Trading stats</SectionTitle>
            {stats ? (
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Window high" value={formatINR(stats.hi)} />
                <Stat label="Window low" value={formatINR(stats.lo)} />
                <Stat label="1W move" value={<span style={{ color: stats.w1 >= 0 ? UP : DOWN }}>{formatPct(stats.w1)}</span>} />
                <Stat label="1M move" value={<span style={{ color: stats.m1 >= 0 ? UP : DOWN }}>{formatPct(stats.m1)}</span>} />
                <Stat label={stats.m3Label} value={<span style={{ color: stats.m3 >= 0 ? UP : DOWN }}>{formatPct(stats.m3)}</span>} />
                <Stat label="Avg volume" value={`${stats.avgVolM.toFixed(2)}M`} sub="per session" />
              </div>
            ) : (
              <p className="text-[12px] text-faint">Loading price history…</p>
            )}
            <p className="mt-2 text-[10px] text-faint">Computed from official NSE EOD data ({candles.length} sessions).</p>
          </div>

          {/* Risk — real, from computed signal flags */}
          <div className="mt-4 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <SectionTitle>Risk</SectionTitle>
              <button onClick={() => setTab('risk')} className="text-[11px] font-semibold text-sky-800 hover:underline">View flags →</button>
            </div>
            {riskSummary ? (
              <div className="flex items-start gap-2">
                <SeverityBadge severity={riskSummary.severity} />
                <span className="text-[12px] leading-snug text-muted">{riskSummary.text}</span>
              </div>
            ) : (
              <p className="text-[12px] text-faint">{feedLoading ? 'Computing risk signals…' : 'Risk signals unavailable.'}</p>
            )}
          </div>

          {/* Insurance KPIs — REAL, sourced from insurers' disclosures (period + source shown) */}
          {ins && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-center justify-between">
                <SectionTitle>Insurance KPIs</SectionTitle>
                <DataSourceBadge variant="live" label={ins.period ? `${ins.period}` : 'reported'} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ins.vnbMarginPct != null && <Stat label="VNB margin" value={`${ins.vnbMarginPct}%`} />}
                {ins.persistency13mPct != null && <Stat label="13M persistency" value={`${ins.persistency13mPct}%`} />}
                {ins.combinedRatioPct != null && <Stat label="Combined ratio" value={`${ins.combinedRatioPct}%`} />}
                {ins.solvencyRatio != null && <Stat label="Solvency" value={`${ins.solvencyRatio}x`} sub="floor 1.5x" />}
                {ins.apeGrowthPct != null && <Stat label="APE growth (YoY)" value={`${ins.apeGrowthPct}%`} />}
                {ins.embeddedValueCr != null && <Stat label="Embedded value" value={`₹${ins.embeddedValueCr.toLocaleString('en-IN')} Cr`} />}
                {ins.marketSharePct != null && <Stat label="Market share" value={`${ins.marketSharePct}%`} />}
              </div>
              {ins.sourceUrl && (
                <a href={ins.sourceUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-faint hover:text-muted">
                  <ExternalLink size={10} /> source
                </a>
              )}
            </div>
          )}
        </div>

        <AlertPanel symbol={sym} lastPrice={headerPrice} onChanged={refreshAlerts} />
        </div>
      </div>

      {/* Desk note + company chat — every company */}
      <div className="mt-5 grid gap-4 xl:grid-cols-12">
        <div className="card p-5 xl:col-span-7">
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-up-soft text-up">
              <Sparkle size={14} />
            </span>
            <h3 className="text-[14px] font-bold text-ink">Desk Note — {sym}</h3>
            <span className="rounded-full bg-panel px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted">
              {feed?.deskNote.ai ? 'AI · refreshed daily' : 'Stats digest'}
            </span>
          </div>
          <p className="max-w-3xl text-[13px] leading-[1.75] text-muted">
            {feed?.deskNote.note ?? (feedLoading ? 'Composing the desk note from live data…' : 'Desk note unavailable — API offline.')}
          </p>
          <Disclaimer />
        </div>
        <div className="xl:col-span-5">
          <CompanyChat symbol={sym} name={name} />
        </div>
      </div>

      {/* Dossier tabs */}
      <div className="mt-8">
        <div className="flex flex-wrap gap-2.5 border-b rule pb-3">
          {tabs.map((t) => (
            <TabButton key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label} <span className="ml-1 font-mono text-[9px] opacity-70">{t.count}</span>
            </TabButton>
          ))}
        </div>

        {feedLoading && <p className="py-8 text-sm italic text-faint">Pulling live company data…</p>}

        {tab === 'facts' && (
          <div className="max-w-4xl">
            {sheetLoading && <p className="py-8 text-sm italic text-faint">Fetching the official fact sheet…</p>}
            {!sheetLoading && !sheet && (
              <p className="py-8 text-[13px] italic text-faint">
                Fact sheet unavailable for {sym} right now —{' '}
                <a href={`https://www.screener.in/company/${sym}/`} target="_blank" rel="noreferrer" className="not-italic text-sky-800 hover:underline">
                  view it on screener.in →
                </a>
              </p>
            )}
            {sheet && (
              <div className="stagger">
                <div className="grid grid-cols-2 gap-2 pt-4 sm:grid-cols-3 lg:grid-cols-4">
                  {sheet.ratios.map((r) => (
                    <div key={r.label} className="rounded-xl bg-panel px-3 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{r.label}</div>
                      <div className="mt-0.5 text-[13.5px] font-bold text-ink">{r.value}</div>
                    </div>
                  ))}
                </div>

                {sheet.about && (
                  <div className="mt-5">
                    <SectionTitle>About the company</SectionTitle>
                    <p className="max-w-3xl text-[13px] leading-[1.75] text-muted">{sheet.about}</p>
                  </div>
                )}

                {(sheet.pros.length > 0 || sheet.cons.length > 0) && (
                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    {sheet.pros.length > 0 && (
                      <div className="rounded-2xl border border-up-soft bg-up-soft p-4">
                        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-up">Strengths noted</div>
                        <ul className="space-y-1.5">
                          {sheet.pros.map((x) => (
                            <li key={x} className="flex gap-2 text-[12.5px] leading-snug text-muted"><span className="text-up">▲</span>{x}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {sheet.cons.length > 0 && (
                      <div className="rounded-2xl border border-down-soft bg-down-soft p-4">
                        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-down">Watch items noted</div>
                        <ul className="space-y-1.5">
                          {sheet.cons.map((x) => (
                            <li key={x} className="flex gap-2 text-[12.5px] leading-snug text-muted"><span className="text-down">▼</span>{x}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                <p className="mt-5 border-t border-dashed rule pt-3 text-[11px] text-faint">
                  Source:{' '}
                  <a href={sheet.url} target="_blank" rel="noreferrer" className="font-semibold text-sky-800 hover:underline">
                    screener.in
                  </a>{' '}
                  · refreshed daily · figures as published there. Strengths/watch items are screener.in's automated analysis, reproduced for reference.
                </p>
              </div>
            )}
          </div>
        )}

        {!feedLoading && tab === 'news' && (
          <div className="stagger max-w-3xl">
            {(feed?.news.length ?? 0) === 0 && <EmptyNote what="tracked news" sym={sym} />}
            {feed?.news.slice(0, 25).map((n) => (
              <article key={n.id} className="border-b rule py-4 last:border-0">
                <div className="flex items-baseline justify-between gap-3">
                  <SentimentBadge sentiment={n.sentiment} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{timeAgo(n.publishedAt, new Date())}</span>
                </div>
                <h4 className="mt-1.5 text-[15px] font-medium leading-snug text-ink">
                  {n.link ? <a href={n.link} target="_blank" rel="noreferrer" className="hover:underline">{n.headline}</a> : n.headline}
                </h4>
                <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{n.source}</div>
              </article>
            ))}
          </div>
        )}

        {!feedLoading && tab === 'announcements' && (
          <div className="stagger max-w-3xl">
            {announcements.length === 0 && <EmptyNote what="exchange announcements" sym={sym} />}
            {announcements.slice(0, 20).map((f) => (
              <article key={f.id} className="border-b rule py-4 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <ExchangeBadge exchange={f.exchange} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{f.category}</span>
                  <span className="ml-auto"><MaterialityBadge materiality={f.materiality} /></span>
                </div>
                <h4 className="mt-1.5 text-[14px] font-medium leading-snug text-strong">
                  {f.link ? <a href={f.link} target="_blank" rel="noreferrer" className="hover:text-sky-800 hover:underline">{f.title}</a> : f.title}
                </h4>
                {f.aiSummary && <p className="mt-1 text-[12.5px] text-muted">{f.aiSummary}</p>}
                <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {timeAgo(f.filedAt, new Date())}
                  {f.link && <a href={f.link} target="_blank" rel="noreferrer" className="ml-3 normal-case text-sky-800 hover:underline">Source PDF →</a>}
                </div>
              </article>
            ))}
            {eventCoverage.length > 0 && (
              <div className="mt-6">
                <SectionTitle>Event coverage — press, past year</SectionTitle>
                {eventCoverage.map((n) => (
                  <article key={n.id} className="border-b rule py-3 last:border-0">
                    <h5 className="text-[13px] font-medium leading-snug text-strong">
                      {n.link ? <a href={n.link} target="_blank" rel="noreferrer" className="hover:text-sky-800 hover:underline">{n.headline}</a> : n.headline}
                    </h5>
                    <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{n.source} · {timeAgo(n.publishedAt, new Date())}</div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {!feedLoading && tab === 'actions' && (          <div className="stagger max-w-3xl">
            {(feed?.corporateActions.length ?? 0) === 0 && <EmptyNote what="corporate actions" sym={sym} />}
            {feed?.corporateActions.map((a, i) => (
              <article key={i} className="flex items-baseline gap-4 border-b rule py-3.5 last:border-0">
                <span className="w-24 shrink-0 font-mono text-[11.5px] font-semibold text-muted">{a.date}</span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${a.type === 'Dividend' ? 'bg-up-soft text-up' : a.type === 'Split' ? 'bg-info-soft text-[#2186c4]' : 'bg-panel text-muted'}`}>
                  {a.type}
                </span>
                <span className="flex-1 text-[13px] text-strong">{a.detail}</span>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint">{a.source}</span>
                {a.link && <a href={a.link} target="_blank" rel="noreferrer" className="shrink-0 text-faint hover:text-sky-700"><ExternalLink size={11} /></a>}
              </article>
            ))}
          </div>
        )}

        {!feedLoading && tab === 'filings' && (
          <div className="stagger max-w-3xl">
            {filingItems.length === 0 && <EmptyNote what="results/board filings" sym={sym} />}
            {filingItems.slice(0, 20).map((f) => (
              <article key={f.id} className="border-b rule py-4 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <ExchangeBadge exchange={f.exchange} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{f.category}</span>
                  <span className="ml-auto"><MaterialityBadge materiality={f.materiality} /></span>
                </div>
                <h4 className="mt-1.5 text-[14px] font-medium leading-snug text-strong">
                  {f.link ? <a href={f.link} target="_blank" rel="noreferrer" className="hover:text-sky-800 hover:underline">{f.title}</a> : f.title}
                </h4>
                {f.aiSummary && <p className="mt-1.5 border-l-2 border-down/70 pl-3 text-[12.5px] italic leading-relaxed text-muted">{f.aiSummary}</p>}
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {timeAgo(f.filedAt, new Date())}
                  {f.link && <a href={f.link} target="_blank" rel="noreferrer" className="ml-3 normal-case text-sky-800 hover:underline">Source PDF →</a>}
                </div>
              </article>
            ))}
            {resultsCoverage.length > 0 && (
              <div className="mt-6">
                <SectionTitle>Results & earnings coverage — press, past year</SectionTitle>
                {resultsCoverage.map((n) => (
                  <article key={n.id} className="border-b rule py-3 last:border-0">
                    <h5 className="text-[13px] font-medium leading-snug text-strong">
                      {n.link ? <a href={n.link} target="_blank" rel="noreferrer" className="hover:text-sky-800 hover:underline">{n.headline}</a> : n.headline}
                    </h5>
                    <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{n.source} · {timeAgo(n.publishedAt, new Date())}</div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {!feedLoading && tab === 'risk' && (          <div className="stagger max-w-3xl">
            {feed?.riskFlags.map((r, i) => (
              <article key={i} className="border-b rule py-4 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <SeverityBadge severity={r.severity} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Signal — {r.signal}</span>
                </div>
                <h4 className="mt-1.5 text-[14px] font-semibold leading-snug text-ink">{r.title}</h4>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{r.description}</p>
              </article>
            ))}
            <p className="py-3 text-[10.5px] text-faint">Flags are computed from real NSE price action and live disclosures.</p>
          </div>
        )}
      </div>
    </div>
  )
}
