import { describe, it, expect } from 'vitest'
import { hashId, escapeRe, wordRe, prevMonth } from './shared'

describe('hashId', () => {
  it('is deterministic and collision-resistant for distinct inputs', () => {
    expect(hashId('hello')).toBe(hashId('hello'))
    expect(hashId('a')).not.toBe(hashId('b'))
  })
})

describe('escapeRe / wordRe', () => {
  it('escapes regex metacharacters so ampersand symbols match literally', () => {
    expect(new RegExp(escapeRe('M&M')).test('M&M')).toBe(true)
    expect(escapeRe('L&T.FH')).toBe('L&T\\.FH')
  })
  it('matches on word boundaries (titan not inside titanium)', () => {
    expect(wordRe('titan').test('titan ltd')).toBe(true)
    expect(wordRe('titan').test('titanium corp')).toBe(false)
  })
})

describe('prevMonth', () => {
  it('returns the previous calendar month as YYYY-MM', () => {
    expect(prevMonth(new Date('2026-07-02T00:00:00Z'))).toBe('2026-06')
  })
  it('rolls the year back across January', () => {
    expect(prevMonth(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12')
  })
})
