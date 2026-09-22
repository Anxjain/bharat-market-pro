// Seed the guidance watchlist with the strategically-watched universe + default config.
// Idempotent: re-running updates theses/tags and leaves owner additions intact.
//   npm run guidance:seed
import '../load-env'
import * as watchRepo from '../repositories/guidanceWatchlist'
import * as cfgRepo from '../repositories/guidanceConfig'
import { DEFAULT_THRESHOLDS, DEFAULT_TIERS } from './config'
import { pool } from '../db/client'

interface Seed {
  symbol: string
  thesis: string
  tags: string[]
}

const UNIVERSE: Seed[] = [
  // ——— PSU banks / financials (govt-backed, systemic, recovery-prone but dilution-sensitive) ———
  { symbol: 'SBIN', thesis: 'Largest PSU bank; sovereign-backed, systemic — core of the financials thesis.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'BANKBARODA', thesis: 'Large PSU bank; cleaned-up book, govt majority owner.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'PNB', thesis: 'PSU bank; turnaround candidate — watch dilution/QIP, which breaks the recovery thesis.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'CANBK', thesis: 'PSU bank; improving asset quality.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'UNIONBANK', thesis: 'PSU bank; govt-owned.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'INDIANB', thesis: 'PSU bank; consistent earnings.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'HDFCBANK', thesis: 'Private-sector anchor; quality compounder, low idiosyncratic risk.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'ICICIBANK', thesis: 'Private bank; strong execution.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'AXISBANK', thesis: 'Private bank; mid-cycle.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'IRFC', thesis: 'PSU rail financier; policy-linked, govt-owned.', tags: ['psu', 'financials', 'infra'] },
  { symbol: 'PFC', thesis: 'PSU power financier; high yield, policy-linked.', tags: ['psu', 'financials', 'energy'] },
  { symbol: 'RECLTD', thesis: 'PSU power financier; rural electrification mandate.', tags: ['psu', 'financials', 'energy'] },
  { symbol: 'LICI', thesis: 'State insurer; huge float, govt majority owner.', tags: ['psu', 'financials', 'insurance'] },

  // ——— Renewables / clean energy (the "can't fall" premise gets stress-tested here) ———
  { symbol: 'SUZLON', thesis: 'Wind OEM; explosive but historically a 90%+ drawdown name — the Suzlon check.', tags: ['renewables', 'wind', 'highvol'] },
  { symbol: 'INOXWIND', thesis: 'Wind OEM; order-book momentum, high volatility.', tags: ['renewables', 'wind', 'highvol'] },
  { symbol: 'TATAPOWER', thesis: 'Integrated power + renewables build-out.', tags: ['renewables', 'energy', 'utility'] },
  { symbol: 'JSWENERGY', thesis: 'Power + aggressive renewables capacity adds.', tags: ['renewables', 'energy', 'utility'] },
  { symbol: 'NHPC', thesis: 'PSU hydro; steady, policy-backed clean energy.', tags: ['psu', 'renewables', 'energy'] },
  { symbol: 'SJVN', thesis: 'PSU hydro + renewables pipeline.', tags: ['psu', 'renewables', 'energy'] },
  { symbol: 'ADANIGREEN', thesis: 'Largest listed renewables pure-play; high valuation + leverage risk.', tags: ['renewables', 'energy', 'highvol'] },

  // ——— Govt-priority infrastructure / energy ———
  { symbol: 'NTPC', thesis: 'Largest power generator; PSU, steady, renewables pivot.', tags: ['psu', 'energy', 'infra'] },
  { symbol: 'POWERGRID', thesis: 'Transmission monopoly; regulated returns, PSU.', tags: ['psu', 'energy', 'infra'] },
  { symbol: 'COALINDIA', thesis: 'Coal monopoly; high dividend, PSU.', tags: ['psu', 'energy'] },
  { symbol: 'ONGC', thesis: 'Upstream oil & gas PSU; cyclical, policy-exposed.', tags: ['psu', 'energy'] },
  { symbol: 'GAIL', thesis: 'Gas transmission PSU; energy-transition linked.', tags: ['psu', 'energy', 'infra'] },
  { symbol: 'BEL', thesis: 'Defence electronics PSU; structural order book.', tags: ['psu', 'defence', 'infra'] },
  { symbol: 'HAL', thesis: 'Defence aerospace PSU; multi-year order visibility.', tags: ['psu', 'defence'] },
  { symbol: 'BHEL', thesis: 'Power-equipment PSU; thermal capex revival play, execution risk.', tags: ['psu', 'infra', 'energy'] },
  { symbol: 'RVNL', thesis: 'Rail infra PSU; order-book momentum, high volatility.', tags: ['psu', 'infra', 'rail', 'highvol'] },
  { symbol: 'IRCON', thesis: 'Rail/infra EPC PSU.', tags: ['psu', 'infra', 'rail'] },
  { symbol: 'NBCC', thesis: 'Govt construction/redevelopment PSU.', tags: ['psu', 'infra'] },

  // ——— Theme deepening (2026-07): more banks, renewables & energy — the owner's focus
  // sectors ("lower risk of falling / the future"). Quality-first within each theme. ———
  { symbol: 'KOTAKBANK', thesis: 'Private bank; conservative underwriting, high-quality franchise.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'INDUSINDBK', thesis: 'Private bank; higher-beta, watch asset quality.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'FEDERALBNK', thesis: 'Private bank; steady mid-cap franchise.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'IDFCFIRSTB', thesis: 'Private bank; retail build-out, improving ratios.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'AUBANK', thesis: 'Small-finance→universal bank; high-growth, premium multiple.', tags: ['financials', 'bank', 'private'] },
  { symbol: 'BANKINDIA', thesis: 'PSU bank; govt-owned, cleaned-up book.', tags: ['psu', 'financials', 'bank'] },
  { symbol: 'IREDA', thesis: 'PSU renewable-energy financier; policy-linked green lending.', tags: ['psu', 'renewables', 'financials', 'energy'] },
  { symbol: 'ADANIENSOL', thesis: 'Adani Energy Solutions; transmission + smart-metering, grid backbone.', tags: ['energy', 'infra', 'renewables', 'highvol'] },
  { symbol: 'PREMIERENE', thesis: 'Premier Energies; solar cell/module manufacturer, PLI tailwind.', tags: ['renewables', 'solar', 'highvol'] },
  { symbol: 'WAAREEENER', thesis: 'Waaree Energies; largest listed solar-module maker.', tags: ['renewables', 'solar', 'highvol'] },
  { symbol: 'ADANIPOWER', thesis: 'Largest private thermal genco; energy, high leverage historically.', tags: ['energy', 'utility', 'highvol'] },
  { symbol: 'TORNTPOWER', thesis: 'Integrated power utility + renewables pivot.', tags: ['energy', 'utility', 'renewables'] },
  { symbol: 'CESC', thesis: 'Power utility; distribution + renewables adds.', tags: ['energy', 'utility'] },
  { symbol: 'RELIANCE', thesis: 'Energy-to-consumer conglomerate; O2C + new-energy build-out.', tags: ['energy', 'oilgas'] },
  { symbol: 'IOC', thesis: 'Largest OMC; refining/marketing PSU, policy-exposed margins.', tags: ['psu', 'energy', 'oilgas'] },
  { symbol: 'BPCL', thesis: 'OMC PSU; refining + fuel retail.', tags: ['psu', 'energy', 'oilgas'] },
  { symbol: 'HPCL', thesis: 'OMC PSU; refining + marketing.', tags: ['psu', 'energy', 'oilgas'] },
  { symbol: 'OIL', thesis: 'Upstream oil & gas PSU; dividend, cyclical.', tags: ['psu', 'energy', 'oilgas'] },
]

async function main(): Promise<void> {
  for (const s of UNIVERSE) await watchRepo.add(s.symbol, s.thesis, s.tags)
  // Write the default tunable config so the owner sees + can edit it in the UI.
  if (!(await cfgRepo.get('thresholds'))) await cfgRepo.set('thresholds', DEFAULT_THRESHOLDS)
  if (!(await cfgRepo.get('tiers'))) await cfgRepo.set('tiers', DEFAULT_TIERS)
  if (!(await cfgRepo.get('weights'))) await cfgRepo.set('weights', {})
  console.log(`[guidance:seed] seeded ${UNIVERSE.length} symbols + default config.`)
  await pool.end()
}

main().catch((e) => {
  console.error('[guidance:seed] fatal:', e)
  process.exit(1)
})
