// 9.6 regime conditioning — the comparable-setup sample must be restricted to instances
// that occurred in today's market state, and must fall back (with regimeConditioned=false)
// when the matched subset is too thin.
import { describe, it, expect } from 'vitest'
import { computeBaseRate, indexStateSeries } from './baserate'
import type { Close } from './factors'

/** Synthetic daily series: `spec` maps day-index → % move; all other days drift +0.05%. */
function series(days: number, spec: Record<number, number>, start = 100): Close[] {
  const out: Close[] = []
  let px = start
  for (let i = 0; i < days; i++) {
    const move = spec[i] ?? 0.05
    px = px * (1 + move / 100)
    // ISO-ish sortable synthetic dates (one per "day", weekends ignored — index alignment
    // in the code only needs lexicographic order, not real calendars).
    out.push({ date: `2020-01-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, close: px })
  }
  return out
}

/** Index: 400 days up (above its 200-DMA), then a crash + 400 days of decline (below). */
function crashIndex(days = 800): Close[] {
  const out: Close[] = []
  let px = 100
  for (let i = 0; i < days; i++) {
    px = px * (1 + (i < 400 ? 0.15 : -0.15) / 100)
    out.push({ date: `2020-01-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, close: px })
  }
  return out
}

describe('indexStateSeries', () => {
  it('labels the rising half above and the falling tail below the 200-DMA', () => {
    const idx = indexStateSeries(crashIndex())
    expect(idx).not.toBeNull()
    expect(idx!.states[0]).toBe('above') // day ~200, still climbing
    expect(idx!.states[idx!.states.length - 1]).toBe('below') // deep in the decline
  })

  it('returns null on a too-short series', () => {
    expect(indexStateSeries(series(100, {}))).toBeNull()
  })
})

describe('computeBaseRate regime conditioning', () => {
  // Stock with 4%-drop setups sprinkled through BOTH index regimes, ≥60 days apart so
  // they stay quasi-independent (maxHorizon 60 below).
  const dropDays: Record<number, number> = {}
  for (const d of [210, 280, 350, 449, 519, 589, 659, 729]) dropDays[d] = -4 // 3 above-regime (210/280/350), 5 below
  const stock = series(800, dropDays)

  const base = {
    symbol: 'TEST',
    selfCloses: stock,
    cohort: [],
    cohortLabel: 'test',
    band: [3, 5] as [number, number],
    horizons: [10, 60],
    direction: 'down' as const,
  }

  it('restricts the sample to today-state instances when the match is big enough', () => {
    const { self } = computeBaseRate({ ...base, minSamples: 4, indexCloses: crashIndex() })
    expect(self.regimeState).toBe('below')
    expect(self.regimeConditioned).toBe(true)
    expect(self.n).toBeLessThan(8) // the above-regime drops were excluded
    expect(self.note).toContain("today's market state")
  })

  it('falls back to all-regimes odds when the matched sample is too thin', () => {
    const { self } = computeBaseRate({ ...base, minSamples: 30, indexCloses: crashIndex() })
    expect(self.regimeState).toBe('below')
    expect(self.regimeConditioned).toBe(false)
    expect(self.n).toBeGreaterThanOrEqual(6) // all instances kept
    expect(self.note).toContain('all-regimes')
  })

  it('is unconditioned when no index history is supplied', () => {
    const { self } = computeBaseRate({ ...base, minSamples: 4 })
    expect(self.regimeState).toBeNull()
    expect(self.regimeConditioned).toBe(false)
  })
})

describe('computeBaseRate point-in-time membership (9.5)', () => {
  // Same synthetic stock as the regime suite: 8 quasi-independent 4%-drop setups.
  const dropDays = [210, 280, 350, 449, 519, 589, 659, 729]
  const spec: Record<number, number> = {}
  for (const d of dropDays) spec[d] = -4
  const stock = series(800, spec)

  const base = {
    symbol: 'TEST',
    selfCloses: stock,
    cohort: [],
    cohortLabel: 'test',
    band: [3, 5] as [number, number],
    horizons: [10, 60],
    direction: 'down' as const,
    minSamples: 4,
  }

  it('drops instances where the symbol was not an index member on the setup date', () => {
    // Member only from "day 500" onward → 4 of the 8 drops survive (519/589/659/729).
    const joined = stock[500].date
    const membership = { coverageStart: stock[0].date, wasMember: (_s: string, date: string) => date >= joined }
    const { self } = computeBaseRate({ ...base, membership })
    expect(self.n).toBe(4)
    expect(self.pitCoverage).toEqual({ from: stock[0].date, conditioned: true })
    expect(self.note).toContain('Point-in-time universe applied')
  })

  it('drops instances that predate membership-ledger coverage', () => {
    // Ledger only covers from "day 400" → the three earlier drops are unknowable, skipped.
    const membership = { coverageStart: stock[400].date, wasMember: () => true }
    const { self } = computeBaseRate({ ...base, membership })
    expect(self.n).toBe(5)
    expect(self.pitCoverage?.conditioned).toBe(true)
  })

  it('falls back to the survivor-conditioned sample when the filtered set is too thin', () => {
    const membership = { coverageStart: stock[0].date, wasMember: () => false }
    const { self } = computeBaseRate({ ...base, membership })
    expect(self.n).toBe(8) // full sample kept
    expect(self.pitCoverage).toEqual({ from: stock[0].date, conditioned: false })
    expect(self.note).toContain('survivor-conditioned')
  })

  it('reports pitCoverage null when no membership data is supplied', () => {
    const { self } = computeBaseRate(base)
    expect(self.pitCoverage).toBeNull()
  })
})

describe('computeBaseRate knn matching (#3)', () => {
  // Two clusters of dips, 12 days apart (> maxHorizon 10, quasi-independent):
  //  • MILD −4% dips that then FALL a further ~3% over 10 days
  //  • DEEP −8% dips that then RECOVER ~+5% over 10 days
  // With knn matching and a deep-dip today, the sample must skew to the deep cluster
  // (median > 0); plain band matching over the whole ladder would blend both.
  const spec: Record<number, number> = {}
  const after: Record<number, number> = {}
  for (let i = 0; i < 15; i++) {
    const mild = 30 + i * 24
    const deep = 42 + i * 24
    spec[mild] = -4
    spec[deep] = -8
    for (let d = 1; d <= 10; d++) {
      after[mild + d] = -0.3 // mild dips bleed lower
      after[deep + d] = 0.5 // deep dips bounce
    }
  }
  const stock = series(420, { ...after, ...spec })
  const base = {
    symbol: 'TEST',
    selfCloses: stock,
    cohort: [],
    cohortLabel: 'test',
    band: [8, 15] as [number, number],
    horizons: [10],
    direction: 'down' as const,
    minSamples: 4,
    allBands: [[3, 5], [5, 8], [8, 15], [15, 100]] as [number, number][],
  }

  it('matches on similarity and skews to the comparable cluster', () => {
    const { self } = computeBaseRate({ ...base, features: { movePct: -8, rsi14: null, ddFromHighPct: null } })
    expect(self.matching).toBe('knn')
    expect(self.k).toBeGreaterThan(0)
    expect(self.horizons[0].median).toBeGreaterThan(0) // deep-dip cluster dominates
    expect(self.note).toContain('most similar to today')
  })

  it('falls back to classic band matching without features', () => {
    const { self } = computeBaseRate({ ...base, allBands: undefined })
    expect(self.matching).toBe('band')
    expect(self.k).toBeNull()
  })
})
