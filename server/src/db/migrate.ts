// Apply Drizzle migrations to this copy's Postgres. Run automatically on server
// boot (ensureSchema) and available standalone via `npm run db:migrate`.
import '../load-env'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, pool } from './client'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_FOLDER = join(here, '..', '..', 'drizzle')

export async function ensureSchema(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}

// Direct invocation: `tsx src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  ensureSchema()
    .then(() => {
      console.log('[db] migrations applied')
      return pool.end()
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[db] migration failed:', e)
      process.exit(1)
    })
}
