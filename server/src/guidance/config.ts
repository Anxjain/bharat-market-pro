// Tunable model configuration for the guidance desk. Defaults live here; the owner
// can override any of them by writing rows into guidance_config (keys: 'weights',
// 'thresholds', 'tiers'). Methodology choices are documented inline + in GUIDANCE.md.
import * as cfgRepo from '../repositories/guidanceConfig'

export interface GuidanceThresholds {
  // Single-day drop bands (%, [min,max)) that define a "setup" for the base rate.
  dropBands: [number, number][]
  lookbackHigh: number // trading days for drawdown-from-high (≈ 1 trading year)
  volWindow: number // realized-vol window (trading days)
  maShort: number
  maLong: number
  horizons: number[] // forward trading-day horizons for the base rate
  recoveredMinSamples: number // n below which a base rate is flagged lowConfidence
}

// Choice notes:
//  • dropBands at 3/5/8% — bands, not a single cutoff, so the base rate is matched to the
//    severity of THIS drop instead of lumping a -3% wobble with a -12% crash.
//  • lookbackHigh = 252 (~1y) for the 52-week-high drawdown convention.
//  • horizons 10/20/40/60 trading days ≈ 2w/1m/2m/3m forward.
export const DEFAULT_THRESHOLDS: GuidanceThresholds = {
  dropBands: [
    [3, 5],
    [5, 8],
    [8, 100],
  ],
  lookbackHigh: 252,
  volWindow: 20,
  maShort: 20,
  maLong: 50,
  horizons: [10, 20, 40, 60],
  recoveredMinSamples: 10,
}

export interface TierCut {
  tier: 'high-conviction' | 'constructive' | 'neutral' | 'avoid'
  min: number // composite-score floor (0–100 scale) for this tier
}

// Tiers are a STANCE, always rendered with the factor stack + base rate, never alone.
export const DEFAULT_TIERS: TierCut[] = [
  { tier: 'high-conviction', min: 65 },
  { tier: 'constructive', min: 42 },
  { tier: 'neutral', min: 22 },
  { tier: 'avoid', min: -1e9 },
]

export interface LoadedConfig {
  weights: Record<string, number> // per-factor-code weight override (empty → use factor defaults)
  thresholds: GuidanceThresholds
  tiers: TierCut[]
}

/** Merge owner overrides (guidance_config) over the built-in defaults. */
export async function loadConfig(): Promise<LoadedConfig> {
  const [weights, thresholds, tiers] = await Promise.all([
    cfgRepo.get<Record<string, number>>('weights'),
    cfgRepo.get<Partial<GuidanceThresholds>>('thresholds'),
    cfgRepo.get<TierCut[]>('tiers'),
  ])
  return {
    weights: weights ?? {},
    thresholds: { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) },
    tiers: tiers && tiers.length ? tiers : DEFAULT_TIERS,
  }
}

export function tierFor(score: number, tiers: TierCut[]): TierCut['tier'] {
  for (const t of [...tiers].sort((a, b) => b.min - a.min)) if (score >= t.min) return t.tier
  return 'avoid'
}
