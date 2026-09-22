// Seed security-name -> NSE symbol aliases (normalized keys; see normSecurity()).
// Drives fund_holdings.normalized_symbol. Phase 4 grows this from the universe.
import { normSecurity } from './types'
import type { AliasRow } from '../repositories/securityAliases'
import * as instrumentsRepo from '../repositories/instruments'
import * as aliasesRepo from '../repositories/securityAliases'

const PAIRS: [string, string][] = [
  ['Reliance Industries', 'RELIANCE'],
  ['ICICI Bank', 'ICICIBANK'],
  ['HDFC Bank', 'HDFCBANK'],
  ['Infosys', 'INFY'],
  ['Bharti Airtel', 'BHARTIARTL'],
  ['Larsen & Toubro', 'LT'],
  ['State Bank of India', 'SBIN'],
  ['NTPC', 'NTPC'],
  ['Titan Company', 'TITAN'],
  ['Axis Bank', 'AXISBANK'],
  ['ITC', 'ITC'],
  ['Tata Consultancy Services', 'TCS'],
  ['Mahindra & Mahindra', 'M&M'],
  ['UltraTech Cement', 'ULTRACEMCO'],
  ['Kotak Mahindra Bank', 'KOTAKBANK'],
  ['Maruti Suzuki India', 'MARUTI'],
  ['Tata Steel', 'TATASTEEL'],
  ['Bajaj Finance', 'BAJFINANCE'],
  ['Hindustan Unilever', 'HINDUNILVR'],
  ['Power Grid Corporation of India', 'POWERGRID'],
  ['Coal India', 'COALINDIA'],
  ['Bharat Electronics', 'BEL'],
  ['Oil & Natural Gas Corporation', 'ONGC'],
  ['Dr Reddys Laboratories', 'DRREDDY'],
  ['Varun Beverages', 'VBL'],
  ['Ajanta Pharma', 'AJANTPHARM'],
  ["Divi's Laboratories", 'DIVISLAB'],
  ['The Federal Bank', 'FEDERALBANK'],
  ['IndusInd Bank', 'INDUSINDBK'],
]

export const SEED_ALIASES: AliasRow[] = PAIRS.map(([name, symbol]) => ({ alias: normSecurity(name), symbol }))


/** De-dupe alias rows by key (last wins) so a single upsert batch is conflict-free. */
function dedupe(rows: AliasRow[]): AliasRow[] {
  const m = new Map<string, string>()
  for (const r of rows) if (r.alias.length >= 3) m.set(r.alias, r.symbol)
  return [...m].map(([alias, symbol]) => ({ alias, symbol }))
}

/**
 * Grow security_aliases from the NIFTY 500 instruments master so holdings ->
 * NSE-symbol coverage isn't limited to the hand-seeded list. Idempotent.
 * Returns the number of aliases written.
 */
export async function buildAliasesFromInstruments(): Promise<number> {
  const rows = await instrumentsRepo.listSymbolName()
  const aliases = dedupe(rows.map((r) => ({ alias: normSecurity(r.name), symbol: r.symbol })))
  return aliasesRepo.upsertMany(aliases)
}

/** Manual seed (names that differ from the instrument master spelling). */
export async function seedManualAliases(): Promise<number> {
  return aliasesRepo.upsertMany(dedupe(SEED_ALIASES))
}
