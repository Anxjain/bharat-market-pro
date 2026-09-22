// Insurance Monitor chat — a grounded assistant that answers ONLY from the real
// ULIP factsheet data we store in Postgres (funds, NAV, AUM, returns, allocations,
// holdings), with an optional web-dive (Gemini Google Search grounding) for context
// the factsheets don't carry. Gives direct views (private tool), like the equity
// research desk in ../chat.ts.
import { complete, routeFor, type ChatMsg, type LlmResult, type Provider } from '../llm'
import * as fundsRepo from '../repositories/funds'
import * as fundReturnsRepo from '../repositories/fundReturns'
import * as fundAllocationsRepo from '../repositories/fundAllocations'
import * as fundHoldingsRepo from '../repositories/fundHoldings'
import * as pricesRepo from '../repositories/prices'
import { freshness } from './freshness'

const SYSTEM = `You are the Bharat Market Pro data desk. You answer two kinds of questions from REAL data we provide in CONTEXT:
1. Indian life-insurance ULIP funds, across all 10 insurers — HDFC Life, ICICI Prudential, Kotak Life, Tata AIA, SBI Life, PNB MetLife, Bharti AXA, Shriram Life, Canara HSBC, Bandhan Life. Per fund we hold the FULL factsheet: NAV, AUM, inception, YTM & modified duration (debt), fund manager(s), returns vs benchmark over every period, asset allocation (with F&U min/max bands), industry/sector exposure, credit-rating profile & maturity profile (debt), and the COMPLETE categorized portfolio holdings (each security under its verbatim factsheet section — Equity / Govt Securities / Corporate Debt / Money Market / …). We also track month-over-month changes (holdings entered/exited/increased/trimmed, allocation & return shifts).
2. NSE-500 equity — end-of-day prices and the precomputed movers/rankings we supply.

VIEWS (private personal tool): give direct opinions. When asked what to buy / what's best / which fund to pick, rank them and recommend a clear choice with the rationale and the key risks. Don't hedge, add no compliance or legal disclaimers, and never refuse to give a view.

HOW TO ANSWER (important — past answers were too thin):
- ANSWER THE QUESTION DIRECTLY AND FULLY. Lead with the actual answer (the name + number), THEN a short supporting detail. Never reply with only a heading.
- The CONTEXT includes PRECOMPUTED RANKINGS (top gainers/losers, top funds by return) — these are AUTHORITATIVE, already sorted from the real data. For any "max / highest / best / top / which … most" question, READ THE ANSWER OFF THE RELEVANT RANKING and state it plainly with its exact %. Do NOT say you cannot rank or compute — the ranking is right there.
- Cite the as-of date/month from the context. For comparisons use a compact markdown table.
- If the data truly doesn't cover it, answer from general knowledge marked "(background knowledge)" and, when web results are present, use them with source names.
- NEVER say the data/context is "small", "limited", "missing", or that you "cannot" — give the best concrete answer available.
- Don't invent precise live numbers; only the CONTEXT (or web results) supply current figures.

STYLE: concise markdown, lead with the answer, tables for comparisons, no disclaimers.`

const INR = (v: number | null | undefined) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)
const PCT = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toFixed(2)}%`)

/** Canonicalize a return-period label — insurers print "1 Year", "1 yr", "1Y", "1 yrs"
 *  all for the same thing, so normalise to 1M/3M/6M/1Y/3Y/5Y… for reliable lookup.
 *  Exported so store.ts canonicalizes once at write time (M-U5). */
export function canonPeriod(raw: string): string {
  const t = raw.toLowerCase().replace(/\s+/g, '')
  let m = t.match(/^(\d+)(y|yr|yrs|year|years)$/)
  if (m) return `${m[1]}Y`
  m = t.match(/^(\d+)(m|mth|mths|month|months)$/)
  if (m) return `${m[1]}M`
  if (/^ytd$/.test(t)) return 'YTD'
  if (/incep/.test(t)) return 'Inception'
  return raw.trim()
}

/** One-line catalog entry for a fund, including trailing returns when known. */
function fundLine(
  f: { name: string; category: string | null; nav: number | null; aumTotalCr: number | null },
  insurerName: string,
  ret?: Map<string, number | null>,
): string {
  const r = (p: string) => (ret?.get(p) != null ? `${p} ${PCT(ret.get(p))}` : '')
  const perf = [r('1Y'), r('3Y'), r('5Y')].filter(Boolean).join(', ')
  return `- ${insurerName} | ${f.name} (${f.category ?? 'n/a'}): NAV ${f.nav ?? '—'}, AUM ${f.aumTotalCr != null ? INR(f.aumTotalCr) + ' Cr' : '—'}${perf ? ', returns ' + perf : ''}`
}

/** YYYY-MM one month earlier (for the month-over-month block). */
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mm - 1, 1)); d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Previous calendar month from today (YYYY-MM) — the sensible default when no month is
 *  stored yet / none was requested (never a hardcoded stale month). */
function defaultMonth(): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// Upper bound on catalog lines handed to the model — the full cross-insurer catalog is
// ~560 funds (~60-80KB); past that we rank by query relevance (then AUM) and cap.
const MAX_CATALOG = 260

/** Deep block for a specific fund: full details + every section + month-over-month change. */
async function fundDetailBlock(sfin: string, month: string, name: string): Promise<string> {
  const prev = prevMonth(month)
  const [fund, returns, allocations, holdings, prevHoldings] = await Promise.all([
    fundsRepo.getBySfinMonth(sfin, month),
    fundReturnsRepo.getForFund(sfin, month),
    fundAllocationsRepo.getForFund(sfin, month),
    fundHoldingsRepo.getForFund(sfin, month),
    fundHoldingsRepo.getForFund(sfin, prev),
  ])
  const ret = returns.length ? returns.map((r) => `${r.period} ${PCT(r.returnPct)} (bm ${PCT(r.benchmarkPct)})`).join('; ') : 'n/a'
  const asset = allocations.filter((a) => a.kind === 'asset').map((a) => `${a.label} ${PCT(a.weight)}${a.fuMin != null || a.fuMax != null ? ` [F&U ${a.fuMin ?? 0}-${a.fuMax ?? 100}%]` : ''}`).join(', ') || 'n/a'
  const sector = allocations.filter((a) => a.kind === 'sector').slice(0, 10).map((a) => `${a.label} ${PCT(a.weight)}`).join(', ') || 'n/a'
  const rating = allocations.filter((a) => a.kind === 'rating').map((a) => `${a.label} ${PCT(a.weight)}`).join(', ')
  const maturity = allocations.filter((a) => a.kind === 'maturity').map((a) => `${a.label} ${PCT(a.weight)}`).join(', ')

  // Holdings grouped by VERBATIM factsheet section (never merged), every security listed.
  const byCat = new Map<string, { security: string; w: number | null }[]>()
  for (const h of holdings) {
    const c = h.category ?? h.rawCategory ?? 'Holdings'
    if (!byCat.has(c)) byCat.set(c, [])
    byCat.get(c)!.push({ security: h.security, w: h.weightPct })
  }
  const holdBlock = byCat.size
    ? [...byCat.entries()].map(([c, rows]) => `    ${c}: ${rows.map((r) => `${r.security} ${PCT(r.w)}`).join(', ')}`).join('\n')
    : '    n/a'

  // Month-over-month portfolio activity (vs the prior stored month, if any).
  // Diff on a CANONICAL key (NSE symbol when resolved, else name stripped of case/
  // whitespace/punctuation) so a pure reformatting of the printed security name
  // ("HDFC Bank Ltd." -> "HDFC Bank Limited") no longer false-fires entered/exited.
  const holdKey = (h: { security: string; normalizedSymbol: string | null }): string =>
    h.normalizedSymbol && h.normalizedSymbol.trim()
      ? `sym:${h.normalizedSymbol.trim().toUpperCase()}`
      : `nm:${h.security.toLowerCase().replace(/[^a-z0-9]+/g, '')}`
  let mom = ''
  if (prevHoldings.length) {
    const sMap = new Map(prevHoldings.map((h) => [holdKey(h), h.weightPct ?? 0]))
    const eMap = new Map(holdings.map((h) => [holdKey(h), h.weightPct ?? 0]))
    const dispMap = new Map(holdings.map((h) => [holdKey(h), h.security]))
    const prevDispMap = new Map(prevHoldings.map((h) => [holdKey(h), h.security]))
    const entered = holdings.filter((h) => !sMap.has(holdKey(h))).map((h) => h.security)
    const exited = prevHoldings.filter((h) => !eMap.has(holdKey(h))).map((h) => h.security)
    const moved = [...eMap.keys()].filter((k) => sMap.has(k)).map((k) => ({ k: dispMap.get(k) ?? prevDispMap.get(k) ?? k, d: eMap.get(k)! - sMap.get(k)! })).filter((x) => Math.abs(x.d) > 0.1)
    const up = moved.filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 6)
    const down = moved.filter((x) => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 6)
    mom = `\n  Month-over-month (${prev}→${month}): entered [${entered.slice(0, 8).join(', ') || 'none'}]; exited [${exited.slice(0, 8).join(', ') || 'none'}]; increased [${up.map((x) => `${x.k} +${x.d.toFixed(2)}pp`).join(', ') || 'none'}]; trimmed [${down.map((x) => `${x.k} ${x.d.toFixed(2)}pp`).join(', ') || 'none'}]`
  }

  const hdr = fund ? `NAV ${fund.nav ?? '—'}, AUM ${fund.aumTotalCr != null ? INR(fund.aumTotalCr) + ' Cr' : '—'}, inception ${fund.inception ?? '—'}${fund.ytm != null ? `, YTM ${PCT(fund.ytm)}` : ''}${fund.modifiedDuration != null ? `, mod.duration ${fund.modifiedDuration}y` : ''}, manager ${fund.manager ?? '—'}` : ''
  return `FUND DETAIL — ${name} (${sfin}):\n  ${hdr}\n  Returns: ${ret}\n  Asset mix: ${asset}\n  Sectors: ${sector}${rating ? `\n  Rating profile: ${rating}` : ''}${maturity ? `\n  Maturity profile: ${maturity}` : ''}\n  Holdings (categorized, full):\n${holdBlock}${mom}`
}

export async function answerUlipChat(
  messages: ChatMsg[],
  opts: { month?: string; webDive?: boolean } = {},
): Promise<{ answer: string; grounded: string[]; model: string; provider: Provider } | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const month = opts.month || (await fundsRepo.latestMonth()) || defaultMonth()
  const grounded: string[] = [`ULIP factsheets ${month}`]

  // Insurer code -> name (from freshness coverage).
  const fresh = await freshness()
  const nameByCode = new Map(fresh.map((f) => [f.code, f.name]))

  // Full fund catalog for the month (compact, one line each), enriched with trailing
  // returns fetched in a single bulk query (so the chat can answer performance Qs).
  const all = await fundsRepo.listVisibleAllMonth(month)
  const retRows = await fundReturnsRepo.getMonthReturns(month)
  const retBySfin = new Map<string, Map<string, number | null>>()
  for (const r of retRows) {
    if (!retBySfin.has(r.sfin)) retBySfin.set(r.sfin, new Map())
    const key = canonPeriod(r.period)
    const m = retBySfin.get(r.sfin)!
    // First non-null wins (a fund may print the same period twice — e.g. absolute + CAGR).
    if (m.get(key) == null) m.set(key, r.returnPct)
  }
  const ql = lastUser.toLowerCase()

  // Catalog, capped to a token budget. When the full set is large, rank by relevance to
  // the question (name/category/insurer term overlap), then by AUM, and keep the top slice
  // so a single chat call doesn't ship 60-80KB of every fund across all 10 insurers.
  let catalogFunds = all
  if (all.length > MAX_CATALOG) {
    const terms = [...new Set(ql.split(/[^a-z0-9]+/).filter((t) => t.length >= 3))]
    const relevance = (f: (typeof all)[number]): number => {
      const hay = `${f.name} ${f.category ?? ''} ${(nameByCode.get(f.insurer) ?? f.insurer)}`.toLowerCase()
      return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
    }
    catalogFunds = [...all]
      .sort((a, b) => relevance(b) - relevance(a) || (b.aumTotalCr ?? 0) - (a.aumTotalCr ?? 0))
      .slice(0, MAX_CATALOG)
  }
  const catalog = catalogFunds.map((f) => fundLine(f, nameByCode.get(f.insurer) ?? f.insurer, retBySfin.get(f.sfin))).join('\n')

  // Detail for funds SPECIFICALLY named in the question (up to 3). Guard against burning the
  // 3 slots on generic matches: require a reasonably long name, skip names shared by many
  // funds across insurers (e.g. a bare "Equity Fund"), and prefer the most specific (longest)
  // matches first so a distinctive fund name wins the slot.
  const nameFreq = new Map<string, number>()
  for (const f of all) { const n = f.name.toLowerCase(); nameFreq.set(n, (nameFreq.get(n) ?? 0) + 1) }
  const named = all
    .filter((f) => f.name && f.name.length >= 8 && ql.includes(f.name.toLowerCase()) && (nameFreq.get(f.name.toLowerCase()) ?? 0) <= 2)
    .sort((a, b) => b.name.length - a.name.length)
    .slice(0, 3)
  const details: string[] = []
  for (const f of named) details.push(await fundDetailBlock(f.sfin, month, f.name))

  // —— Precomputed rankings: LLMs can't reliably sort a text dump, so we compute the
  // answer to "max / top / highest / which-most" questions in code and hand it over. ——
  const rankings: string[] = []

  // NSE equity movers — intraday (open→close) and day-over-day (close vs prior session).
  try {
    const dates = await pricesRepo.distinctRecentDates(2)
    if (dates.length >= 1) {
      const last = dates[0]
      const prev = dates[1] ?? dates[0]
      const rows = await pricesRepo.sessionRows(last, prev)
      const fmt = (a: { symbol: string; name: string; pct: number }[]) =>
        a.map((x) => `${x.name} (${x.symbol}) ${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(2)}%`).join(', ')
      const intraday = rows
        .filter((r) => r.open != null && r.close != null && (r.open as number) > 0)
        .map((r) => ({ symbol: r.symbol, name: r.name, pct: (((r.close as number) - (r.open as number)) / (r.open as number)) * 100 }))
        .sort((a, b) => b.pct - a.pct)
      const dayChg = rows
        .filter((r) => r.close != null && r.prevClose != null && (r.prevClose as number) > 0)
        .map((r) => ({ symbol: r.symbol, name: r.name, pct: (((r.close as number) - (r.prevClose as number)) / (r.prevClose as number)) * 100 }))
        .sort((a, b) => b.pct - a.pct)
      if (intraday.length) {
        grounded.push(`NSE EOD ${last}`)
        rankings.push(
          `NSE EQUITY MOVERS — session ${last}, ${intraday.length} stocks (PRECOMPUTED, authoritative):\n` +
            `• Intraday (open→close) top gainers: ${fmt(intraday.slice(0, 10))}\n` +
            `• Intraday top losers: ${fmt(intraday.slice(-10).reverse())}\n` +
            `• Day-over-day (close vs ${prev}) top gainers: ${fmt(dayChg.slice(0, 10))}\n` +
            `• Day-over-day top losers: ${fmt(dayChg.slice(-10).reverse())}`,
        )
      }

      // Per-company open/close when the question names specific NSE stocks (symbol or name).
      const tu = lastUser.toUpperCase()
      const tl = lastUser.toLowerCase()
      const named = rows
        .filter((r) => {
          if (r.close == null) return false
          if (new RegExp(`\\b${r.symbol.replace(/[^A-Z0-9]/g, '')}\\b`).test(tu)) return true
          const short = r.name.toLowerCase().replace(/\b(ltd|limited)\b/g, '').replace(/[.,]/g, '').trim()
          return short.length >= 5 && tl.includes(short)
        })
        .slice(0, 8)
      if (named.length) {
        rankings.push(
          `MENTIONED NSE STOCKS — session ${last} (PRECOMPUTED open/close):\n` +
            named
              .map((r) => `${r.name} (${r.symbol}): open ₹${r.open ?? '—'}, close ₹${r.close}, prev close ₹${r.prevClose ?? '—'}${r.open != null && r.close != null && (r.open as number) > 0 ? `, intraday ${((((r.close as number) - (r.open as number)) / (r.open as number)) * 100).toFixed(2)}%` : ''}`)
              .join('\n'),
        )
      }
    }
  } catch {
    /* equity analytics optional */
  }

  // Top ULIP funds by trailing return, per period (precomputed ranking over the data).
  for (const period of ['1Y', '3Y', '5Y']) {
    const ranked = all
      .map((f) => ({ f, r: retBySfin.get(f.sfin)?.get(period) ?? null }))
      .filter((x) => x.r != null)
      .sort((a, b) => (b.r as number) - (a.r as number))
    if (ranked.length) {
      rankings.push(
        `TOP ULIP FUNDS BY ${period} RETURN (PRECOMPUTED): ` +
          ranked.slice(0, 8).map((x) => `${x.f.name} [${nameByCode.get(x.f.insurer) ?? x.f.insurer}] ${PCT(x.r)}`).join('; '),
      )
    }
  }

  // Precomputed per-insurer fund counts (so "how many funds…" is exact, not eyeballed).
  const countByInsurer = new Map<string, number>()
  for (const f of all) countByInsurer.set(f.insurer, (countByInsurer.get(f.insurer) ?? 0) + 1)
  const countsLine = [...countByInsurer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${nameByCode.get(c) ?? c} ${n}`)
    .join('; ')

  const rankBlock = rankings.length ? `PRECOMPUTED RANKINGS (read max/top/highest/which-most answers straight off these):\n${rankings.join('\n\n')}\n\n` : ''
  const coverage = `ULIP COVERAGE (PRECOMPUTED): ${all.length} funds total across ${countByInsurer.size} insurers — per insurer: ${countsLine}; as-of ${month}.`
  const context =
    rankBlock +
    coverage + '\n\n' +
    `FUND CATALOG:\n${catalog}` +
    (details.length ? `\n\n${details.join('\n\n')}` : '')

  const buildMessages = (forWeb: boolean): ChatMsg[] => {
    // Web fallback model has a smaller budget — keep the rankings + details, drop the long catalog.
    const ctx = forWeb && context.length > 2400
      ? rankBlock + coverage + (details.length ? `\n\n${details.join('\n\n')}` : '')
      : context
    const history = messages.slice(forWeb ? -2 : -8)
    return [
      { role: 'system', content: SYSTEM },
      ...history,
      {
        role: 'user',
        content: `CONTEXT (real Bharat Market Pro data — prefer it, cite the as-of date/month):\n${ctx}\n\nAnswer the last user message directly and completely — lead with the actual answer.${forWeb ? ' If the context is not enough, also search the web and name the sources.' : ''}`,
      },
    ]
  }

  const finalize = (r: LlmResult) => ({
    answer: r.text,
    grounded: r.sources?.length ? [...grounded, ...r.sources] : grounded,
    model: r.model,
    provider: r.provider,
  })

  // Web-dive ON: hit the live web (Gemini Google Search grounding) first.
  if (opts.webDive) {
    const dive = await complete(buildMessages(true), { ...routeFor('webDive'), maxTokens: 1400 })
    if (dive) return finalize(dive)
  }

  // Default: grounded answer from our data (generous budget so answers aren't truncated to a heading).
  const out = await complete(buildMessages(false), { ...routeFor('chat'), maxTokens: 2000 })
  if (out) return finalize(out)

  // Last resort: web dive if the grounded path failed entirely.
  const dive = await complete(buildMessages(true), { ...routeFor('webDive'), maxTokens: 900 })
  return dive ? finalize(dive) : null
}
