// AI-style summary generation — RULE-BASED for the prototype.
// Every function here is a pure template over the mock dataset.
// Phase 2: swap each function body for a LLM API call (keep the signatures).

import { companies, companyBySymbol, insuranceMetrics, type Company } from '../data/companies'
import { indices, sectorPerformance, marketBreadth } from '../data/market'
import { news, type NewsItem } from '../data/news'
import { riskEvents } from '../data/risks'
import { filings } from '../data/filings'
import { formatPct } from './format'

/** Daily market brief for the overview page. */
export function generateMarketSummary(): string {
  const nifty = indices.find((i) => i.name === 'NIFTY 50')!
  const bank = indices.find((i) => i.name === 'NIFTY BANK')!
  const it = indices.find((i) => i.name === 'NIFTY IT')!
  const vix = indices.find((i) => i.name === 'INDIA VIX')!
  const best = [...sectorPerformance].sort((a, b) => b.dayChangePct - a.dayChangePct)[0]
  const worst = [...sectorPerformance].sort((a, b) => a.dayChangePct - b.dayChangePct)[0]
  const breadthTone = marketBreadth.advancers > marketBreadth.decliners ? 'positive' : 'negative'

  return [
    `Indian equities closed ${nifty.changePct >= 0 ? 'higher' : 'lower'} with the NIFTY 50 at ${nifty.value.toLocaleString('en-IN')} (${formatPct(nifty.changePct)}). Breadth was ${breadthTone} — ${marketBreadth.advancers} advancers against ${marketBreadth.decliners} decliners.`,
    `${best.sector} led sector gains (${formatPct(best.dayChangePct)}) while ${worst.sector} lagged (${formatPct(worst.dayChangePct)}). Banks outperformed with NIFTY BANK ${formatPct(bank.changePct)}; IT remained under pressure (${formatPct(it.changePct)}) on cautious BFSI spend commentary.`,
    `Institutional flows were supportive: FIIs net bought ₹${marketBreadth.fiiNetCr.toLocaleString('en-IN')} cr and DIIs ₹${marketBreadth.diiNetCr.toLocaleString('en-IN')} cr (provisional). India VIX at ${vix.value} (${formatPct(vix.changePct)}) signals subdued near-term volatility expectations.`,
    `Key watch items: the Reliance Retail DRHP, the IRDAI expense-of-management consultation for insurers, and RBI's unsecured-lending caution for NBFCs.`,
  ].join(' ')
}

/** Company research summary for the Company 360 page. */
export function generateCompanySummary(c: Company): string {
  const growthTone =
    c.profitGrowthPct >= 15 ? 'strong' : c.profitGrowthPct >= 8 ? 'steady' : 'modest'
  const valuationTone = c.pe >= 35 ? 'rich' : c.pe >= 20 ? 'full' : 'reasonable'
  const riskTone = c.riskScore >= 55 ? 'elevated' : c.riskScore >= 40 ? 'moderate' : 'contained'

  const companyNews = news.filter((n) => n.tickers.includes(c.symbol))
  const positives = companyNews.filter((n) => n.sentiment === 'positive').length
  const negatives = companyNews.filter((n) => n.sentiment === 'negative').length
  const newsTone =
    positives > negatives ? 'constructive' : negatives > positives ? 'cautious' : 'balanced'

  const activeRisks = riskEvents.filter((r) => r.symbol === c.symbol)
  const topRisk = activeRisks[0]

  const ins = insuranceMetrics.find((m) => m.symbol === c.symbol)
  const insLine = ins
    ? ins.type === 'Life'
      ? ` As a life insurer, the key metrics stand at VNB margin ${ins.vnbMarginPct}%, 13-month persistency ${ins.persistency13mPct}% and solvency ${ins.solvencyRatio}x (regulatory floor 1.5x).`
      : ` As a ${ins.type.toLowerCase()} insurer, combined ratio is ${ins.combinedRatioPct}% with solvency at ${ins.solvencyRatio}x (regulatory floor 1.5x).`
    : ''

  return [
    `${c.name} (${c.symbol}) is a ${c.sector.toLowerCase()} sector company — ${c.description}`,
    `Fundamentals show ${growthTone} momentum: revenue ${formatPct(c.revenueGrowthPct)} and profit ${formatPct(c.profitGrowthPct)} YoY, with ROE of ${c.roe}%. The stock trades at a ${valuationTone} ${c.pe}x P/E with a beta of ${c.beta}.${insLine}`,
    `Recent news flow is ${newsTone} (${positives} positive / ${negatives} negative items tracked). Composite risk is ${riskTone} at ${c.riskScore}/100.` +
      (topRisk ? ` Primary watch item: ${topRisk.title.toLowerCase()}.` : ' No active risk flags on the monitor.'),
  ].join(' ')
}

/** Plain-language explanation of a company's risk score. */
export function explainRiskScore(c: Company): string {
  const parts: string[] = []
  if (c.debtToEquity > 1) parts.push(`leverage is high (D/E ${c.debtToEquity}x)`)
  if (c.beta > 1.2) parts.push(`the stock is more volatile than the market (beta ${c.beta})`)
  if (c.pe > 40) parts.push(`valuation leaves little room for execution slips (P/E ${c.pe}x)`)
  const flags = riskEvents.filter((r) => r.symbol === c.symbol)
  if (flags.length) parts.push(`${flags.length} active risk flag${flags.length > 1 ? 's' : ''} on the monitor`)
  if (parts.length === 0) parts.push('no structural red flags; score reflects normal market and sector risk')
  const band = c.riskScore >= 55 ? 'Elevated' : c.riskScore >= 40 ? 'Moderate' : 'Low-to-moderate'
  return `${band} risk (${c.riskScore}/100): ${parts.join('; ')}.`
}

/** Aggregate news sentiment for a set of tickers (or all). */
export function sentimentBreakdown(symbols?: string[]): { positive: number; negative: number; neutral: number; items: NewsItem[] } {
  const items = symbols ? news.filter((n) => n.tickers.some((t) => symbols.includes(t))) : news
  return {
    positive: items.filter((n) => n.sentiment === 'positive').length,
    negative: items.filter((n) => n.sentiment === 'negative').length,
    neutral: items.filter((n) => n.sentiment === 'neutral').length,
    items,
  }
}

/** Insurance sector AI commentary. */
export function generateInsuranceSummary(): string {
  const life = insuranceMetrics.filter((m) => m.type === 'Life')
  const bestVnb = [...life].sort((a, b) => (b.vnbMarginPct ?? 0) - (a.vnbMarginPct ?? 0))[0]
  return [
    `The insurance sector is navigating a heavy regulatory agenda: IRDAI's draft expense-of-management norms and the proposed composite-licence amendment are the two structural themes.`,
    `Among life insurers, ${companyBySymbol.get(bestVnb.symbol)?.name} leads on VNB margin (${bestVnb.vnbMarginPct}%); private players continue to take new-business share from LIC (May APE: private +11% vs industry +8%).`,
    `In general insurance, motor pricing discipline is improving combined ratios, while standalone health faces medical-inflation-driven repricing — Star Health's 12% group hike is the live test case for retention.`,
    `All covered insurers remain comfortably above the 1.5x regulatory solvency floor.`,
  ].join(' ')
}

/** One-line filing digest lookup (precomputed in dataset, exposed via one API for Phase 2 swap). */
export function getFilingDigest(filingId: string): string {
  return filings.find((f) => f.id === filingId)?.aiSummary ?? ''
}

/** Top movers across the coverage universe. */
export function topMovers(count = 4): { gainers: Company[]; losers: Company[] } {
  const sorted = [...companies].sort((a, b) => b.dayChangePct - a.dayChangePct)
  return { gainers: sorted.slice(0, count), losers: sorted.slice(-count).reverse() }
}
