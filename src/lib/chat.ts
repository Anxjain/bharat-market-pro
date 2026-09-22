// Rule-based research chat assistant for the prototype.
// Intent detection over the mock dataset; answers are grounded in data modules.
// Phase 2: replace answerQuery() with a LLM API call that receives the same
// dataset as tool results / context — the ChatMessage interface stays the same.

import { companies, companyBySymbol, insurers, insuranceMetrics } from '../data/companies'
import { sectorPerformance } from '../data/market'
import { news } from '../data/news'
import { filings } from '../data/filings'
import { riskEvents } from '../data/risks'
import { generateCompanySummary, generateMarketSummary, generateInsuranceSummary, explainRiskScore, topMovers } from './ai'
import { formatCrore, formatPct } from './format'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

function findCompanies(q: string) {
  const upper = q.toUpperCase()
  const lower = q.toLowerCase()
  const wordHit = (term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  return companies.filter((c) => {
    if (wordHit(c.symbol).test(upper)) return true
    // First name token, but only if it's distinctive (>=4 chars) to avoid
    // false hits on generic words like "state", "life", "bajaj".
    const first = c.name.toLowerCase().split(' ')[0]
    return first.length >= 4 && wordHit(first).test(lower)
  })
}

export function answerQuery(query: string): string {
  const q = query.toLowerCase()
  const matched = findCompanies(query)

  // Comparison: two or more companies mentioned with compare-ish wording
  if (matched.length >= 2 && /(compare|vs\b|versus|better|against)/.test(q)) {
    const [a, b] = matched
    const rows = [
      ['Market cap', formatCrore(a.marketCapCr), formatCrore(b.marketCapCr)],
      ['P/E', `${a.pe}x`, `${b.pe}x`],
      ['ROE', `${a.roe}%`, `${b.roe}%`],
      ['Revenue growth (YoY)', formatPct(a.revenueGrowthPct), formatPct(b.revenueGrowthPct)],
      ['Profit growth (YoY)', formatPct(a.profitGrowthPct), formatPct(b.profitGrowthPct)],
      ['Risk score', `${a.riskScore}/100`, `${b.riskScore}/100`],
    ]
    return (
      `**${a.name} vs ${b.name}**\n\n` +
      `| Metric | ${a.symbol} | ${b.symbol} |\n|---|---|---|\n` +
      rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n') +
      `\n\n${a.symbol} shows ${a.profitGrowthPct > b.profitGrowthPct ? 'faster' : 'slower'} profit growth, while ${b.symbol} carries ${b.riskScore > a.riskScore ? 'a higher' : 'a lower'} composite risk score.`
    )
  }

  // Risk questions
  if (/(risk|safe|danger|concern|red flag)/.test(q)) {
    if (matched.length) {
      const c = matched[0]
      const flags = riskEvents.filter((r) => r.symbol === c.symbol)
      const flagText = flags.length
        ? '\n\nActive flags:\n' + flags.map((f) => `- **[${f.severity.toUpperCase()}] ${f.title}** — ${f.description}`).join('\n')
        : '\n\nNo active flags on the risk monitor.'
      return `**Risk view: ${c.name}**\n\n${explainRiskScore(c)}${flagText}`
    }
    const top = [...riskEvents].sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity)).slice(0, 4)
    return (
      `**Top risk flags across coverage right now:**\n\n` +
      top.map((f) => `- **[${f.severity.toUpperCase()}] ${companyBySymbol.get(f.symbol)?.name}** — ${f.title}`).join('\n') +
      `\n\nAsk about a specific company for a detailed risk breakdown.`
    )
  }

  // News questions
  if (/(news|headline|happening|latest|update)/.test(q)) {
    const items = matched.length ? news.filter((n) => n.tickers.some((t) => matched.some((m) => m.symbol === t))) : news.slice(0, 5)
    if (!items.length) return `No tracked news for that query in the current dataset.`
    return (
      `**Latest tracked news${matched.length ? ` for ${matched.map((m) => m.symbol).join(', ')}` : ''}:**\n\n` +
      items.slice(0, 5).map((n) => `- ${n.sentiment === 'positive' ? '🟢' : n.sentiment === 'negative' ? '🔴' : '⚪'} **${n.headline}** (${n.source}) — ${n.summary}`).join('\n')
    )
  }

  // Filings questions
  if (/(filing|announcement|disclosure|nse|bse|drhp|board meeting)/.test(q)) {
    const items = matched.length ? filings.filter((f) => matched.some((m) => m.symbol === f.symbol)) : filings.filter((f) => f.materiality === 'high')
    return (
      `**${matched.length ? `Filings for ${matched.map((m) => m.symbol).join(', ')}` : 'High-materiality filings this week'}:**\n\n` +
      items.slice(0, 5).map((f) => `- **[${f.exchange}] ${companyBySymbol.get(f.symbol)?.name}** — ${f.title}\n  _${f.aiSummary}_`).join('\n')
    )
  }

  // Insurance sector
  if (/(insurance|insurer|irdai|vnb|solvency|persistency|life insurance|health insurance)/.test(q)) {
    const table = insuranceMetrics
      .map((m) => {
        const c = companyBySymbol.get(m.symbol)!
        return `| ${c.symbol} | ${m.type} | ${m.vnbMarginPct ? m.vnbMarginPct + '%' : '—'} | ${m.solvencyRatio}x | ${m.combinedRatioPct ? m.combinedRatioPct + '%' : '—'} |`
      })
      .join('\n')
    return `${generateInsuranceSummary()}\n\n| Insurer | Type | VNB margin | Solvency | Combined ratio |\n|---|---|---|---|---|\n${table}`
  }

  // Sector questions
  const sector = sectorPerformance.find((s) => q.includes(s.sector.toLowerCase()))
  if (sector && /(sector|how is|performance|doing)/.test(q)) {
    const inSector = companies.filter((c) => c.sector === sector.sector)
    return (
      `**${sector.sector} sector today:** ${formatPct(sector.dayChangePct)} (${sector.advancers} advancing / ${sector.decliners} declining).\n\n` +
      `Covered names: ${inSector.map((c) => `${c.name} (${formatPct(c.dayChangePct)})`).join(', ') || 'none in current coverage'}.`
    )
  }

  // Market overview
  if (/(market|nifty|sensex|today|overview|summary|brief)/.test(q)) {
    return `**Market brief:**\n\n${generateMarketSummary()}`
  }

  // Movers
  if (/(gainer|loser|mover|top stock|best|worst)/.test(q)) {
    const { gainers, losers } = topMovers(3)
    return (
      `**Top movers in coverage today:**\n\n` +
      `Gainers: ${gainers.map((c) => `${c.symbol} ${formatPct(c.dayChangePct)}`).join(', ')}\n\n` +
      `Losers: ${losers.map((c) => `${c.symbol} ${formatPct(c.dayChangePct)}`).join(', ')}`
    )
  }

  // Single company deep dive
  if (matched.length === 1) {
    return `**Research note: ${matched[0].name}**\n\n${generateCompanySummary(matched[0])}`
  }

  // Fallback / help
  return [
    `I can answer research questions over the current coverage universe (${companies.length} companies, ${insurers.length} insurers). Try:`,
    `- "Summarize Reliance" or "Tell me about SBI Life"`,
    `- "Compare TCS vs Infosys"`,
    `- "What are the biggest risks right now?"`,
    `- "Latest news on Bajaj Finance"`,
    `- "Show high-materiality filings"`,
    `- "How is the insurance sector doing?"`,
    `- "Market summary today"`,
  ].join('\n')
}
