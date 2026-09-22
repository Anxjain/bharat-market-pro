// Adapter registry — 8 active insurers + 2 parked (schema-ready, not built).
import type { UlipAdapter } from './types'
import { hdfc } from './hdfc'
import { tataaia } from './tataaia'
import { kotak } from './kotak'
import { sbi } from './sbi'
import { pnbmetlife } from './pnbmetlife'
import { bhartiaxa } from './bhartiaxa'
import { bandhan } from './bandhan'
import { icicipru } from './icicipru'
import { canarahsbc } from './canarahsbc'
import { shriram } from './shriram'

export const ADAPTERS: Record<string, UlipAdapter> = {
  hdfc,
  tataaia,
  kotak,
  sbi,
  pnbmetlife,
  bhartiaxa,
  bandhan,
  icicipru,
  canarahsbc,
  shriram,
}

// PARKED: registered in the insurers table as schema-ready placeholders, but no
// pipeline adapter is built (per Phase 5 scope).
export interface ParkedInsurer {
  irdaiCode: string
  name: string
  website: string
}
// Canara HSBC (136) and Shriram (128) are now ACTIVE adapters above — no parked
// placeholders remain. All 10 in-scope insurers have a built adapter.
export const PARKED_INSURERS: ParkedInsurer[] = []

export function getAdapter(id: string): UlipAdapter {
  const a = ADAPTERS[id]
  if (!a) throw new Error(`unknown ULIP adapter: ${id}`)
  return a
}

export type { UlipAdapter, UlipDoc, ScrapedLink } from './types'
