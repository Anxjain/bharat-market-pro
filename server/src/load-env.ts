// Tiny .env loader (side-effect import). Reads server/.env (KEY=VALUE) into
// process.env without overriding already-set vars. Dependency-free; mirrors the
// loader in llm.ts so DATABASE_URL / PORT / API keys all resolve the same way.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './util/shared'

const here = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(here, '..', '.env')

export function loadEnv(): void {
  loadEnvFile(ENV_PATH)
}

loadEnv()
