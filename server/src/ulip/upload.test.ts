// Identification of an uploaded factsheet: which insurer, which month.
//
// Both answers are read out of the document rather than taken from the upload form,
// so these are the checks that stop one insurer's holdings being filed under another,
// or a month being stored under the wrong label. Every fixture below is text copied
// from a real published factsheet — the shapes here are the ones that actually broke.
import { describe, it, expect } from 'vitest'
import { detectInsurer, detectMonth } from './upload'

describe('detectInsurer', () => {
  it('reads the insurer code from the END of a contiguous SFIN', () => {
    // HDFC prints SFIN and page number on one line; the page number must not be
    // absorbed into the SFIN and read as the insurer code.
    const text = `
      Policy Discontinued Fund - Life        ULIF05110/03/11DiscontdPF101    53
      HDFC Life Discovery Fund               ULIF06618/01/18DiscvryFnd101    55
    `
    expect(detectInsurer(text).id).toBe('hdfc')
  })

  it('handles a mnemonic that itself ends in a digit', () => {
    // Bandhan's SFINs read "…EEF0138": the tail is 138, NOT 013. Matching mid-token
    // instead of at the end got this wrong and identified no insurer at all.
    const text = `
      ULIF00105/07/08EEF0138
      ULIF01203/09/10ACCELERATE0138
      ULGF00228/03/11GEQUITY0138
    `
    expect(detectInsurer(text).id).toBe('bandhan')
  })

  it('handles SFINs printed with spaces', () => {
    const text = 'SFIN: ULIF 060 15/07/14 MCF 110 — Whole Life Mid Cap Equity Fund'
    expect(detectInsurer(text).id).toBe('tataaia')
  })

  it('takes the majority when another insurer is mentioned in passing', () => {
    const text = `
      ULIF01102/01/04BalancedMF101
      ULIF00402/01/04BalancedMF101
      benchmark comparison vs ULIF 060 15/07/14 MCF 110
    `
    expect(detectInsurer(text).id).toBe('hdfc')
  })

  it('falls back to the brand when SFINs are truncated in the text layer', () => {
    // ICICI Prudential's performance PDF carries SFINs cut off before the insurer
    // code ("ULIF 161 091025"), so there is nothing to count.
    const text = 'ULIF 161 091025\nULIF 087 24/11/09\nICICI Pru BSE 100 Index'
    expect(detectInsurer(text).id).toBe('icicipru')
  })

  it('returns null rather than guessing when there is no evidence', () => {
    expect(detectInsurer('Quarterly investment newsletter. No fund codes here.').id).toBeNull()
  })
})

describe('detectMonth', () => {
  it('reads an explicit as-on date', () => {
    expect(detectMonth('Balanced Managed Fund - Life as on May 29, 2026')).toBe('2026-05')
  })

  it('prefers the reported month over the publication month', () => {
    // PNB MetLife's cover says "June 2026 Edition" while all 36 fund pages report
    // "May 31, 2026". Taking the first date seen filed the whole month as June.
    const text = ['Monthly Fund Performance', 'June 2026 Edition', ...Array(36).fill('May 31, 2026')].join('\n')
    expect(detectMonth(text)).toBe('2026-05')
  })

  it('accepts day-first dates', () => {
    expect(detectMonth('Fund Fact Sheet 31 May 2026')).toBe('2026-05')
  })

  it('accepts a bare month-year banner', () => {
    expect(detectMonth('FUND FACTSHEET\nMAY 2026')).toBe('2026-05')
  })

  it('returns null when the document carries no date', () => {
    expect(detectMonth('Fund performance summary, all figures annualised.')).toBeNull()
  })
})
