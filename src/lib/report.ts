// Report generation: daily watchlist brief + company research brief.
// Built from REAL data fetched at compose time (prices, fact sheet, company feed,
// index context). Any field without a real value is omitted — never mock-filled.

import { formatINR, formatPct } from './format'

// ——— minimal response shapes (subset of the API payloads we read) ———
interface QuoteT { key: string; price: number; changePct: number }
interface QuotesResp { quotes: QuoteT[] }
interface UniverseRowT { symbol: string; name: string; industry: string; close: number | null; changePct: number | null }
interface UniverseResp { rows: UniverseRowT[]; asOf: string | null }
interface SheetT { source?: string; ratios: { label: string; value: string }[] }
interface FeedT {
  name?: string
  industry?: string
  deskNote?: { note: string }
  news?: { headline: string; source: string }[]
  announcements?: { category: string; title: string }[]
  corporateActions?: { date: string; type: string; detail: string }[]
  riskFlags?: { severity: string; title: string; description: string }[]
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(35_000) })
    return r.ok ? ((await r.json()) as T) : null
  } catch {
    return null
  }
}

function today(): string {
  return new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

async function niftyContextLine(): Promise<string | null> {
  const resp = await getJson<QuotesResp>(`/api/quotes?keys=${encodeURIComponent('NIFTY 50')}`)
  const n = resp?.quotes?.find((q) => q.key === 'NIFTY 50')
  return n ? `NIFTY 50: ${n.price.toLocaleString('en-IN')} (${formatPct(n.changePct)})` : null
}

export async function buildCompanyBrief(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase()
  const [feed, sheet, quoteResp, niftyLine] = await Promise.all([
    getJson<FeedT>(`/api/company-feed/${encodeURIComponent(sym)}`),
    getJson<SheetT>(`/api/fact-sheet/${encodeURIComponent(sym)}`),
    getJson<QuotesResp>(`/api/quotes?keys=${encodeURIComponent(sym)}`),
    niftyContextLine(),
  ])
  const name = feed?.name ?? sym
  const q = quoteResp?.quotes?.find((x) => x.key === sym)
  const lines: string[] = []

  lines.push(`# Company Research Brief — ${name} (${sym})`)
  lines.push(`\n_As of ${today()} · Bharat Market Pro._\n`)

  const snap: string[] = []
  if (q) snap.push(`- **Price:** ${formatINR(q.price)} (${formatPct(q.changePct)}) — delayed quote`)
  if (feed?.industry) snap.push(`- **Industry:** ${feed.industry}`)
  if (snap.length) {
    lines.push(`## Snapshot\n`)
    lines.push(snap.join('\n'))
  }

  if (feed?.deskNote?.note) {
    lines.push(`\n## Desk note\n`)
    lines.push(feed.deskNote.note)
  }

  if (sheet?.ratios?.length) {
    lines.push(`\n## Key ratios — ${sheet.source ?? 'screener.in'}\n`)
    lines.push(`| Metric | Value |`)
    lines.push(`|---|---|`)
    for (const r of sheet.ratios) lines.push(`| ${r.label} | ${r.value} |`)
  }

  if (feed?.riskFlags?.length) {
    lines.push(`\n## Risk signals\n`)
    for (const f of feed.riskFlags) lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title} — ${f.description}`)
  }

  if (feed?.news?.length) {
    lines.push(`\n## Recent news\n`)
    for (const n of feed.news.slice(0, 8)) lines.push(`- ${n.headline} — _${n.source}_`)
  }

  if (feed?.announcements?.length) {
    lines.push(`\n## Exchange announcements\n`)
    for (const f of feed.announcements.slice(0, 8)) lines.push(`- **[${f.category}]** ${f.title}`)
  }

  if (feed?.corporateActions?.length) {
    lines.push(`\n## Corporate actions\n`)
    for (const a of feed.corporateActions.slice(0, 8)) lines.push(`- ${a.date} · ${a.type} — ${a.detail}`)
  }

  if (niftyLine) {
    lines.push(`\n## Market context\n`)
    lines.push(niftyLine)
  }

  return lines.join('\n')
}

export async function buildWatchlistBrief(symbols: string[]): Promise<string> {
  const [uni, niftyLine] = await Promise.all([getJson<UniverseResp>(`/api/universe`), niftyContextLine()])
  const rows = uni?.rows ?? []
  const byMap = new Map(rows.map((r) => [r.symbol, r]))
  const lines: string[] = []

  lines.push(`# Daily Watchlist Brief — ${today()}`)
  lines.push(`\n_Bharat Market Pro._\n`)

  // Market context — NIFTY + real breadth
  const rated = rows.filter((r) => r.changePct != null)
  const adv = rated.filter((r) => (r.changePct ?? 0) > 0).length
  const dec = rated.filter((r) => (r.changePct ?? 0) < 0).length
  const ctx: string[] = []
  if (niftyLine) ctx.push(`${niftyLine}.`)
  if (rated.length) ctx.push(`Breadth across ${rated.length} NIFTY 500 names: ${adv} advancing vs ${dec} declining.`)
  lines.push(`## Market context\n`)
  lines.push(ctx.join(' ') || 'Market context unavailable.')

  // Snapshot table — real close + day change
  if (symbols.length) {
    lines.push(`\n## Watchlist snapshot\n`)
    lines.push(`| Company | Price | Day |`)
    lines.push(`|---|---|---|`)
    for (const s of symbols) {
      const r = byMap.get(s)
      const name = r?.name ?? s
      const price = r?.close != null ? formatINR(r.close) : '—'
      const day = r?.changePct != null ? formatPct(r.changePct) : '—'
      lines.push(`| ${name} (${s}) | ${price} | ${day} |`)
    }

    // Per-company detail from real feeds (parallel)
    const feeds = await Promise.all(symbols.map((s) => getJson<FeedT>(`/api/company-feed/${encodeURIComponent(s)}`)))
    symbols.forEach((s, i) => {
      const feed = feeds[i]
      if (!feed) return
      lines.push(`\n## ${feed.name ?? s} (${s})\n`)
      if (feed.deskNote?.note) lines.push(feed.deskNote.note)
      const topRisk = (feed.riskFlags ?? [])[0]
      if (topRisk) lines.push(`\n**Top risk:** [${topRisk.severity.toUpperCase()}] ${topRisk.title}`)
      if (feed.news?.length) {
        lines.push(`\n**News:**`)
        for (const n of feed.news.slice(0, 3)) lines.push(`- ${n.headline} — _${n.source}_`)
      }
      if (feed.announcements?.length) {
        lines.push(`\n**Filings:**`)
        for (const f of feed.announcements.slice(0, 3)) lines.push(`- [${f.category}] ${f.title}`)
      }
    })
  }

  return lines.join('\n')
}

/** Trigger a browser download of a markdown report. */
export function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // Some browsers cancel the download if the anchor isn't in the document, or
  // if the object URL is revoked before the click is processed.
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
