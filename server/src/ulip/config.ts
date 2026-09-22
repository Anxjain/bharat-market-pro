// ULIP pipeline paths (all inside this copy's folder; never reach outside it).
// Relative env values resolve against the copy root (folder "1"); absolute wins.
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // server/src/ulip
const ROOT1 = resolve(here, '..', '..', '..') // project root

function fromEnvOr(envVar: string, fallback: string): string {
  const v = process.env[envVar]
  if (!v) return fallback
  return isAbsolute(v) ? v : resolve(ROOT1, v)
}

// Raw archive root: <project>/raw
export const RAW_DIR = fromEnvOr('RAW_DIR', join(ROOT1, 'raw'))

// Bundled reference factsheets (optional offline fallback): sibling folder "2"
export const REF_DIR = fromEnvOr('ULIP_REF_DIR', resolve(ROOT1, '..', '2'))

// Human-readable factsheet library: every fetched PDF is also saved here with a
// bank-name + date filename (e.g. Kotak-Mahindra-Life_2026-05_fetched-2026-06-18.pdf)
// alongside a manifest.json. This is the "downloaded the insurer's PDF and saved it"
// copy; raw/ keeps the stable-named originals for the pipeline's idempotency cache.
export const FACTSHEET_DIR = fromEnvOr('ULIP_FACTSHEET_DIR', join(ROOT1, 'factsheets'))

// Manual intake: drop an insurer PDF here as <id>_<YYYY-MM>.pdf (e.g.
// icicipru_2026-05.pdf) or <id>.pdf, and the pipeline ingests it when live fetch
// fails and no bundled reference exists. The universal "I have the PDF, just
// extract it" escape hatch — covers bot-protected/JS sites (ICICI Pru, Bandhan).
export const INTAKE_DIR = fromEnvOr('ULIP_INTAKE_DIR', join(ROOT1, 'intake'))
