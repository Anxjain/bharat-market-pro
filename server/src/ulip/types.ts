// Strict JSON contract the extractor (Gemini, or the offline fixture) returns.
// Keyed by SFIN; one object per fund. zod-validated before it reaches the store.
import { z } from 'zod'

export const ReturnZ = z.object({
  period: z.string(),
  returnPct: z.number().nullable(),
  benchmarkPct: z.number().nullable(),
})

export const AllocationZ = z.object({
  kind: z.enum(['asset', 'sector', 'fnu', 'rating', 'maturity']),
  label: z.string(),
  weight: z.number().nullable(),
  fuMin: z.number().nullable().optional(),
  fuMax: z.number().nullable().optional(),
})

export const HoldingZ = z.object({
  security: z.string(),
  weightPct: z.number().nullable(),
  category: z.string().nullable().optional(),     // canonical bucket (Equity/Debt/Govt Securities/Money Market/Mutual Fund-ETF/Cash/Other)
  rawCategory: z.string().nullable().optional(),  // bank's own section label, verbatim
  isin: z.string().nullable().optional(),
  rating: z.string().nullable().optional(),
  marketValue: z.number().nullable().optional(),
})

export const AumZ = z.object({
  equity: z.number().nullable(),
  debt: z.number().nullable(),
  mmi: z.number().nullable(),
  total: z.number().nullable(),
})

export const ExtractedFundZ = z.object({
  sfin: z.string(),
  name: z.string(),
  class: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  nav: z.number().nullable().optional(),
  inception: z.string().nullable().optional(),
  benchmark: z.string().nullable().optional(),
  manager: z.string().nullable().optional(),
  ytm: z.number().nullable().optional(),              // yield to maturity (%) — debt funds
  modifiedDuration: z.number().nullable().optional(), // years — debt funds
  managedSummary: z.string().nullable().optional(),   // "Equity - 6 | Debt - 0 | Balanced -3"
  aum: AumZ.partial().nullable().optional(),
  returns: z.array(ReturnZ).default([]),
  allocations: z.array(AllocationZ).default([]),
  holdings: z.array(HoldingZ).default([]),
  // Per-field extraction coverage: field -> 'present' | 'absent' | 'partial'.
  coverage: z.record(z.string(), z.string()).optional(),
})

export const ExtractionZ = z.object({ funds: z.array(ExtractedFundZ) })

export type ExtractedFund = z.infer<typeof ExtractedFundZ>

/** Canonical SFIN: uppercase, no spaces/slashes-noise. Last 3 chars = IRDAI code. */
export function normalizeSfin(s: string): string {
  // Canonical SFIN: uppercase, no spaces or hyphens (insurers print both for
  // readability, e.g. Kotak "ULIF-033-...-107", SBI "EQUITY-FND"); slashes in the
  // date are kept. The last 3 chars remain the IRDAI code.
  return s.toUpperCase().replace(/[\s-]+/g, '').trim()
}

/** Normalize a security name for alias lookup (drop suffixes/punctuation). */
export function normSecurity(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, '')
    .replace(/\b(ltd|limited)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
