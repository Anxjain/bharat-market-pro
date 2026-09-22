// Postgres connection for THIS copy of Bharat Market Pro.
//
// Single shared pg Pool + Drizzle instance. The connection string comes from
// DATABASE_URL (see server/.env, fed by docker-compose). The default points at
// the dedicated, isolated database for this copy — never the original project's.
import '../load-env'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bharat_market_pro:bharat_market_pro@localhost:5433/bharat_market_pro'

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? 10_000),
})

// CR-4: node-postgres emits 'error' on IDLE clients (Postgres restart, network blip,
// container recycle). With NO listener Node treats it as an unhandled error and exits
// the whole process — a single DB hiccup would take the entire API + frontend down.
// Log and swallow: the pool transparently reconnects on the next query.
pool.on('error', (e) => console.error('[db] idle client error:', e.message))

export const db = drizzle(pool, { schema })

export type DB = typeof db
