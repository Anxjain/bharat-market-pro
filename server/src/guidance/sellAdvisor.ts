// Sell advisor — the "when to get out" engine for every user's paper positions.
//
// The desk's customer holds ~3–18 months and extends past 1.5 years ONLY when real
// growth is showing. Buying advice is everywhere; exit discipline is what actually
// decides returns at this horizon. Every evening (after the fresh bhavcopy + label
// update) this reviews each user's open positions and raises advisories — in-app
// notifications always, email too when SMTP is configured. Every advisory carries the
// house-style fact line: the number, the dates, and the source it came from.
//
// Checks, most urgent first:
//   1. trailing-drawdown — gave back a big chunk from the post-entry peak (12% warn,
//      18% urgent). Riding round-trips is the classic sub-1.5y mistake.
//   2. hard-loss — position deep under the entry with no stop-loss protecting it.
//   3. thesis-breaker — a dilution/auditor/pledge/rating filing landed (NSE, linked).
//   4. earnings — the business's quarterly profits are deteriorating (screener.in).
//   5. horizon-review — held ≥ 1.5 years: extend only if it beat the index AND the
//      trend is intact ("real growth"); otherwise it's dead money — move on.
//   6. ltcg — held 12 months: gains now tax at 12.5% LTCG instead of 20% STCG.
import * as ptRepo from '../repositories/paperTrading'
import * as pricesRepo from '../repositories/prices'
import * as filingsRepo from '../repositories/filings'
import * as resultsRepo from '../repositories/guidanceResults'
import * as notifRepo from '../repositories/guidanceNotifications'
import { latestQuote } from './portfolio'
import { indexReturnPct } from './labels'
import { sendMail, mailConfigured } from '../mail'
import type { ResultsTrend } from './results'

const HORIZON_DAYS = 548 // 1.5 years — the customer's stated max unless growth is real
const round1 = (n: number) => Math.round(n * 10) / 10

// Same patterns the factor engine treats as thesis-breakers.
const DILUTION_RX = /qip|qualified institutions? placement|preferential (allotment|issue)|rights issue|fund ?rais|fresh issue|further public offer|increase in (authorized|authorised)(?: share)? capital|\bdilut/i
const RISK_RX = /fraud|default|insolvency|resignation of (statutory )?auditor|auditor resign|sebi order|penalty|pledge|encumbr|downgrade|rating.*(revis|downgrad)|nclt|investigation/i

interface Advisory {
  positionId: number
  symbol: string
  kind: string
  severity: 'info' | 'warn' | 'urgent'
  title: string
  body: string
  fact: string
  dedupeDays: number
}

function heldDays(entryDate: string): number {
  return Math.floor((Date.now() - Date.parse(`${entryDate}T00:00:00Z`)) / 864e5)
}

/** All advisories for one open position. Pure evaluation — dedupe/persist is the caller's. */
async function evaluatePosition(pos: ptRepo.PositionRow): Promise<Advisory[]> {
  const out: Advisory[] = []
  const q = await latestQuote(pos.symbol)
  if (!q) return out
  const pnlPct = ((q.price - pos.entryPrice) / pos.entryPrice) * 100
  const held = heldDays(pos.entryDate)

  // 1. trailing drawdown from the post-entry peak
  const bars = await pricesRepo.barsAfter(pos.symbol, pos.entryDate).catch(() => [])
  let peak = pos.entryPrice
  let peakDate = pos.entryDate
  for (const b of bars) if (b.close > peak) { peak = b.close; peakDate = b.date }
  if (q.price > peak) { peak = q.price; peakDate = q.date }
  const offPeak = ((q.price - peak) / peak) * 100
  if (offPeak <= -18) {
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'trailing-drawdown', severity: 'urgent', dedupeDays: 5,
      title: `${pos.symbol}: given back ${round1(Math.abs(offPeak))}% from its peak — consider selling now`,
      body: `Since you bought, ${pos.symbol} peaked at ₹${round1(peak)} and has fallen ${round1(Math.abs(offPeak))}% from there (now ₹${round1(q.price)}, ${pnlPct >= 0 ? `still +${round1(pnlPct)}%` : `${round1(pnlPct)}%`} vs your entry). At your holding horizon, riding a round-trip is how gains die — protect what's left.`,
      fact: `Peak ₹${round1(peak)} (${peakDate}) → ₹${round1(q.price)} (${q.date}) — our stored NSE daily closes + live quote`,
    })
  } else if (offPeak <= -12) {
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'trailing-drawdown', severity: 'warn', dedupeDays: 5,
      title: `${pos.symbol}: ${round1(Math.abs(offPeak))}% below its post-entry peak — consider selling soon`,
      body: `${pos.symbol} peaked at ₹${round1(peak)} after your entry and now trades ₹${round1(q.price)} (${pnlPct >= 0 ? `+${round1(pnlPct)}%` : `${round1(pnlPct)}%`} vs entry). If the pullback deepens past ~18%, the desk will call it urgent. Tightening the stop-loss here costs nothing.`,
      fact: `Peak ₹${round1(peak)} (${peakDate}) → ₹${round1(q.price)} (${q.date}) — our stored NSE daily closes + live quote`,
    })
  }

  // 2. hard loss with no stop protecting the position
  if (pos.stopLoss == null && pnlPct <= -20) {
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'hard-loss', severity: 'urgent', dedupeDays: 5,
      title: `${pos.symbol}: ${round1(Math.abs(pnlPct))}% under your entry with NO stop-loss — decide now`,
      body: `You bought at ₹${round1(pos.entryPrice)} (${pos.entryDate}); it's ₹${round1(q.price)}. A ${round1(Math.abs(pnlPct))}% loss needs a ${round1((pos.entryPrice / q.price - 1) * 100)}% rise just to break even. Either the thesis still holds — then set a stop and a target — or it doesn't: sell.`,
      fact: `Entry ₹${round1(pos.entryPrice)} (${pos.entryDate}) → ₹${round1(q.price)} (${q.date}) — our stored NSE closes + live quote`,
    })
  } else if (pos.stopLoss == null && pnlPct <= -12) {
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'hard-loss', severity: 'warn', dedupeDays: 7,
      title: `${pos.symbol}: ${round1(Math.abs(pnlPct))}% under entry, unprotected — set a stop or plan the exit`,
      body: `${pos.symbol} is ${round1(Math.abs(pnlPct))}% below your ₹${round1(pos.entryPrice)} entry and the position has no stop-loss. Decide the level where you'd be wrong and set it — unbounded downside is not a strategy.`,
      fact: `Entry ₹${round1(pos.entryPrice)} (${pos.entryDate}) → ₹${round1(q.price)} (${q.date}) — our stored NSE closes + live quote`,
    })
  }

  // 3. thesis-breaker filings in the last 21 days
  const since = new Date(Date.now() - 21 * 864e5).toISOString()
  const filings = await filingsRepo.forSymbolSince(pos.symbol, since).catch(() => [])
  const breaker = filings.find((f) => DILUTION_RX.test(`${f.category} ${f.title}`) || RISK_RX.test(`${f.category} ${f.title}`))
  if (breaker) {
    const isDilution = DILUTION_RX.test(`${breaker.category} ${breaker.title}`)
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'thesis-breaker', severity: 'urgent', dedupeDays: 7,
      title: `${pos.symbol}: ${isDilution ? 'capital raise / dilution' : 'serious disclosure'} filed — risky now, consider selling soon`,
      body: `A ${isDilution ? 'dilution event (QIP/rights/preferential — new shares cut your per-share claim)' : 'risk disclosure (auditor/rating/pledge/legal — the kind that keeps prices sliding)'} was filed on ${breaker.filedAt.slice(0, 10)}: "${breaker.title.slice(0, 140)}". This is the desk's hardest category of red flag.`,
      fact: `NSE filing, ${breaker.filedAt.slice(0, 10)} — ${breaker.link}`,
    })
  }

  // 4. earnings deterioration (cached quarterly trend)
  const res = await resultsRepo.get<ResultsTrend>(pos.symbol).catch(() => null)
  if (res?.json?.direction === 'deteriorating') {
    const p = res.json.profitTtmGrowth
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'earnings', severity: 'warn', dedupeDays: 30,
      title: `${pos.symbol}: quarterly profits are deteriorating — re-check the thesis`,
      body: `The business behind your position is weakening${p != null ? ` — profit ${p}% over the trailing year` : ''}. Price can outrun earnings for a while, but at your horizon the P&L eventually wins. If you bought the story, verify the story still exists.`,
      fact: `screener.in quarterly results${res.json.asOfQuarter ? ` through ${res.json.asOfQuarter}` : ''}, trend: deteriorating`,
    })
  }

  // 5. the 1.5-year horizon review — extend ONLY on real growth
  if (held >= HORIZON_DAYS) {
    const idx = await indexReturnPct(pos.entryDate, q.date)
    const trendRef = bars[bars.length - 63]
    const trendUp = trendRef ? q.price > trendRef.close : pnlPct > 0
    const beatIndex = idx != null && pnlPct > idx
    if (beatIndex && trendUp) {
      out.push({
        positionId: pos.id, symbol: pos.symbol, kind: 'horizon-review', severity: 'info', dedupeDays: 45,
        title: `${pos.symbol}: 1.5-year mark — growth is real, extending is justified`,
        body: `Held ${held} days: +${round1(pnlPct)}% vs NIFTY's ${idx != null ? `${idx >= 0 ? '+' : ''}${round1(idx)}%` : '—'} over the same period, and the 3-month trend is still up. Your own rule — stay past 1.5 years only when real growth shows — says this one has earned the extension. Re-review quarterly.`,
        fact: `Position ${pnlPct >= 0 ? '+' : ''}${round1(pnlPct)}% (${pos.entryDate} → ${q.date}) vs NIFTY ${idx != null ? `${idx >= 0 ? '+' : ''}${round1(idx)}%` : '—'} — our stored closes + NIFTY series`,
      })
    } else {
      out.push({
        positionId: pos.id, symbol: pos.symbol, kind: 'horizon-review', severity: 'warn', dedupeDays: 45,
        title: `${pos.symbol}: 1.5-year mark reached without earning the extension — time to move on`,
        body: `Held ${held} days: ${pnlPct >= 0 ? '+' : ''}${round1(pnlPct)}% vs NIFTY's ${idx != null ? `${idx >= 0 ? '+' : ''}${round1(idx)}%` : '—'} over the same window${trendUp ? '' : ', and the 3-month trend has rolled over'}. ${beatIndex ? 'The trend is gone even though it beat the index — momentum has left.' : 'An index fund would have done the same or better with zero single-stock risk.'} Your horizon rule says sell and redeploy.`,
        fact: `Position ${pnlPct >= 0 ? '+' : ''}${round1(pnlPct)}% (${pos.entryDate} → ${q.date}) vs NIFTY ${idx != null ? `${idx >= 0 ? '+' : ''}${round1(idx)}%` : '—'} — our stored closes + NIFTY series`,
      })
    }
  }

  // 6. LTCG milestone (informational, fires once around the 12-month mark)
  if (held >= 365 && held <= 380) {
    out.push({
      positionId: pos.id, symbol: pos.symbol, kind: 'ltcg', severity: 'info', dedupeDays: 400,
      title: `${pos.symbol}: crossed 12 months — gains now taxed at 12.5% (LTCG), not 20%`,
      body: `This position just became long-term for tax. If you were waiting to book ${pnlPct >= 0 ? `the +${round1(pnlPct)}%` : 'a result'}, the tax drag on selling is now 12.5% instead of 20% on gains.`,
      fact: `Entry ${pos.entryDate}, ${held} days held — Indian equity STCG 20% / LTCG 12.5% (Finance Act 2024 rates)`,
    })
  }

  return out
}

/** Evening sweep across EVERY user's open positions: persist deduped advisories in-app,
 *  and email each user their warn/urgent items when SMTP is configured. Never throws. */
export async function sellAdvisorSweep(): Promise<void> {
  if (process.env.GUIDANCE_ENABLED !== 'true') return
  try {
    const open = await ptRepo.openPositions()
    const byUser = new Map<string, Advisory[]>()
    for (const pos of open) {
      const advisories = await evaluatePosition(pos).catch((e) => {
        console.warn(`[sell-advisor] ${pos.symbol} #${pos.id} failed: ${(e as Error).message}`)
        return [] as Advisory[]
      })
      for (const a of advisories) {
        if (await notifRepo.firedRecently(pos.userEmail, a.positionId, a.kind, a.dedupeDays)) continue
        await notifRepo.insert({ userEmail: pos.userEmail, positionId: a.positionId, symbol: a.symbol, kind: a.kind, severity: a.severity, title: a.title, body: a.body, fact: a.fact })
        const list = byUser.get(pos.userEmail) ?? []
        list.push(a)
        byUser.set(pos.userEmail, list)
      }
    }

    let mailed = 0
    for (const [user, advisories] of byUser) {
      const serious = advisories.filter((a) => a.severity !== 'info')
      console.log(`[sell-advisor] ${user}: ${advisories.length} advisories (${serious.length} serious)`)
      if (serious.length === 0 || !mailConfigured() || !user.includes('@') || user === 'dev@local') continue
      const html = `<div style="font-family:sans-serif;max-width:640px">
        <h2 style="margin:0 0 4px">Bharat Market Pro — position risk advisories</h2>
        <p style="color:#666;margin:0 0 16px">From today's review of your mock portfolio. Every point cites its data.</p>
        ${serious.map((a) => `
          <div style="border:1px solid #e5e7eb;border-left:4px solid ${a.severity === 'urgent' ? '#c43a3a' : '#c9a03a'};border-radius:8px;padding:12px;margin-bottom:10px">
            <b>${a.title}</b>
            <p style="margin:6px 0">${a.body}</p>
            <p style="color:#888;font-size:12px;margin:0">Basis: ${a.fact}</p>
          </div>`).join('')}
        <p style="color:#999;font-size:11px">Mock portfolio decision support — sizes and P&amp;L are simulated.</p>
      </div>`
      if (await sendMail({ to: [user], subject: `Bharat Market Pro: ${serious.length} position advisor${serious.length === 1 ? 'y' : 'ies'} — ${serious[0].symbol}${serious.length > 1 ? ' +' + (serious.length - 1) : ''}`, html })) mailed++
    }
    if (byUser.size > 0) console.log(`[sell-advisor] sweep done — ${[...byUser.values()].flat().length} advisories across ${byUser.size} user(s), ${mailed} email(s) sent`)
  } catch (e) {
    console.warn('[sell-advisor] sweep failed:', (e as Error).message)
  }
}
