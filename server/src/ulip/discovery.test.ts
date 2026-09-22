// inferMonth is the month-labelling gate for every archived factsheet (listing discovery
// AND the as-on verification in archive.ts key off it) — a misread here stores an
// insurer's document under the wrong month, so the formats are pinned by test.
import { describe, it, expect } from 'vitest'
import { inferMonth } from './discovery'

describe('inferMonth', () => {
  it('reads numeric year-month', () => {
    expect(inferMonth('factsheet 2026-05 final')).toBe('2026-05')
    expect(inferMonth('2026_05_report')).toBe('2026-05')
  })
  it('reads month-name + year (full and 2-digit)', () => {
    expect(inferMonth('newsletter-fund-factsheet-jan-2026.pdf')).toBe('2026-01')
    expect(inferMonth('factsheets-for-jun-26-v2.pdf')).toBe('2026-06')
    expect(inferMonth('InDepth May 2026')).toBe('2026-05')
  })
  it('reads a full date without mistaking the day for a 2-digit year', () => {
    // "Jan 23, 2026" used to parse as year 2023 — mislabelled every Bharti factsheet.
    expect(inferMonth('as of Jan 23, 2026')).toBe('2026-01')
    expect(inferMonth('as of Feb 27, 2026')).toBe('2026-02')
    expect(inferMonth('Apr 28 2026')).toBe('2026-04')
  })
  it('returns null when nothing month-like exists', () => {
    expect(inferMonth('annual report')).toBeNull()
  })
})
