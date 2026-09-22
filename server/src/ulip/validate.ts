// Deterministic ULIP validators — NO LLM. The extractor may err; these checks
// catch it loudly. Each fund gets a confidence score, a flag list, and a bucket:
//   clean      -> show normally
//   suspicious -> show WITH an "unverified" marker (had warnings)
//   failed     -> QUARANTINE, never shown (had a hard reject)
import type { ExtractedFund } from './types'
import { normalizeSfin } from './types'

export type Severity = 'warn' | 'reject'
export interface Flag {
  code: string
  severity: Severity
  message: string
}
export type FundStatus = 'clean' | 'suspicious' | 'failed'

export interface ValidationContext {
  insurerCode: string
  priorNav?: number | null
  priorHoldingsCount?: number | null
}

export interface ValidationResult {
  status: FundStatus
  confidence: number
  flags: Flag[]
}

const SFIN_RE = /^UL(IF|GF|PF)[A-Z0-9/]*\d{3}$/
// Aggregation/cash buckets that legitimately exceed the single-holding warn band.
const BUCKET_RE = /\b(other|others|mmi|cash|net current|money market|total|misc|treps|repo|deposit|sub-?total|tri-?party)\b/i

/** Generous "sane" return band per period (annualized for multi-year). */
function returnBand(period: string): [number, number] {
  const p = period.toLowerCase()
  if (/(^|[^0-9])1m|1 month/.test(p)) return [-40, 40]
  if (/3m|3 month/.test(p)) return [-60, 60]
  if (/6m|6 month|ytd/.test(p)) return [-70, 80]
  if (/1y|1 year/.test(p)) return [-90, 150]
  return [-50, 75] // 2Y+ CAGR / inception
}

export function validateFund(f: ExtractedFund, ctx: ValidationContext): ValidationResult {
  const flags: Flag[] = []
  const add = (code: string, severity: Severity, message: string) => flags.push({ code, severity, message })

  const sfin = normalizeSfin(f.sfin)

  // SFIN format + insurer-code match (last 3 digits).
  if (!SFIN_RE.test(sfin)) add('sfin_format', 'reject', `SFIN "${sfin}" is not a valid ULIF/ULGF/ULPF code`)
  if (sfin.slice(-3) !== ctx.insurerCode) add('sfin_insurer', 'reject', `SFIN last-3 (${sfin.slice(-3)}) != insurer ${ctx.insurerCode}`)

  // NAV numeric/positive, and within ~25% MoM of the prior month. A MISSING NAV is
  // only a warning (some insurers publish a returns-only "fund performance" sheet with
  // no NAV column — e.g. ICICI Pru); a present-but-broken NAV (<=0 / non-finite) is a
  // hard reject (parse error).
  if (f.nav == null) {
    add('nav_missing', 'warn', 'NAV not present in the source document')
  } else if (!Number.isFinite(f.nav) || f.nav <= 0) {
    add('nav_invalid', 'reject', `NAV not a positive number (${f.nav})`)
  } else if (ctx.priorNav != null && ctx.priorNav > 0) {
    const mom = Math.abs((f.nav - ctx.priorNav) / ctx.priorNav) * 100
    if (mom > 25) add('nav_mom', 'warn', `NAV moved ${mom.toFixed(1)}% MoM (prior ${ctx.priorNav}, now ${f.nav})`)
  }

  // Asset allocation should sum to ~100% (allows a small cash residual).
  const asset = f.allocations.filter((a) => a.kind === 'asset')
  if (asset.length) {
    const sum = asset.reduce((s, a) => s + (a.weight ?? 0), 0)
    const off = Math.abs(sum - 100)
    // The asset-allocation table is a SECONDARY field — a fund's holdings/NAV/returns can be
    // perfectly good while its asset split rounds off or omits a cash row. So a bad asset sum
    // must NOT hide the whole fund: only a physically-impossible sum (>130%, a real double-
    // count / page mis-attach) is a hard reject; everything else is a warning (shown with the
    // "unverified" marker). This un-quarantines legit funds (e.g. Shriram gilt funds off by a
    // few %) that the old sum≥90 && off>5 rule wrongly failed.
    if (sum > 130) add('asset_sum', 'reject', `asset allocation sums to ${sum.toFixed(2)}% (>130, double-counted)`)
    else if (off > 5) add('asset_sum', 'warn', `asset allocation sums to ${sum.toFixed(2)}% (off ${off.toFixed(2)})`)
    else if (off > 2) add('asset_sum', 'warn', `asset allocation sums to ${sum.toFixed(2)}%`)
  }

  // Per-holding bounds + concentration + no over-allocation.
  let hSum = 0
  for (const h of f.holdings) {
    const w = h.weightPct
    if (w == null) continue
    hSum += w
    if (w < 0 || w > 100) add('holding_range', 'reject', `holding "${h.security}" weight ${w}% out of [0,100]`)
    else if (w > 15 && !BUCKET_RE.test(h.security)) add('holding_concentration', 'warn', `holding "${h.security}" is ${w}% (>15%)`)
  }
  // A portfolio can legitimately sum to <100 (the untabulated tail / cash isn't itemized),
  // but >110 means a section was double-counted (e.g. a page mis-attach) — quarantine it.
  if (hSum > 110) add('holdings_sum', 'reject', `holdings sum to ${hSum.toFixed(2)}% (>110, likely double-counted)`)
  else if (hSum > 100.5) add('holdings_sum', 'warn', `holdings sum to ${hSum.toFixed(2)}% (>100)`)
  // Floor warning: a weighted portfolio summing far below 100 usually means the extractor
  // missed rows (truncated table / dropped a section). Only when weights are actually present.
  else if (hSum > 0 && hSum < 60 && f.holdings.some((h) => h.weightPct != null)) {
    add('holdings_sum_low', 'warn', `holdings sum to ${hSum.toFixed(2)}% (<60, likely incomplete extraction)`)
  }

  // AUM parts reconcile to total (treat nulls as 0; 1% + paise tolerance).
  const a = f.aum
  if (a && a.total != null && Number.isFinite(a.total) && a.total > 0) {
    const hasParts = a.equity != null || a.debt != null || a.mmi != null
    if (hasParts) {
      const parts = (a.equity ?? 0) + (a.debt ?? 0) + (a.mmi ?? 0)
      if (Math.abs(parts - a.total) > a.total * 0.01 + 0.5) add('aum_reconcile', 'warn', `AUM parts ${parts} != total ${a.total}`)
    }
  }

  // Returns within sane bands per period.
  for (const r of f.returns) {
    if (r.returnPct == null) continue
    const [lo, hi] = returnBand(r.period)
    if (r.returnPct < lo || r.returnPct > hi) add('return_band', 'warn', `${r.period} return ${r.returnPct}% outside [${lo},${hi}]`)
  }
  // Percent-sanity: a fund whose every non-zero return is |v|<1 was almost certainly
  // extracted as a fraction (0.12) rather than a percent (12%) — flag it (bands miss this).
  const nzReturns = f.returns.map((r) => r.returnPct).filter((v): v is number => v != null && v !== 0)
  if (nzReturns.length >= 3 && nzReturns.every((v) => Math.abs(v) < 1)) {
    add('returns_fractional', 'warn', `all ${nzReturns.length} returns have |value|<1 — looks fractional (0.12 = 12%?), not percent`)
  }

  // Holding count vs prior month (big drop = likely a parse miss).
  if (ctx.priorHoldingsCount != null && ctx.priorHoldingsCount > 0 && f.holdings.length < ctx.priorHoldingsCount * 0.5) {
    add('holdings_drop', 'warn', `holdings dropped ${ctx.priorHoldingsCount} -> ${f.holdings.length}`)
  }

  const rejects = flags.filter((x) => x.severity === 'reject').length
  const warns = flags.filter((x) => x.severity === 'warn').length
  const status: FundStatus = rejects > 0 ? 'failed' : warns > 0 ? 'suspicious' : 'clean'
  const confidence = Math.max(0, Math.min(1, 1 - 0.4 * rejects - 0.12 * warns))
  return { status, confidence, flags }
}
