// drizzle-kit config: generates SQL migrations from src/db/schema.ts.
// DATABASE_URL is supplied by the npm scripts (which load server/.env) or the
// environment; falls back to this copy's dedicated, isolated Postgres database.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bharat_market_pro:bharat_market_pro@localhost:5433/bharat_market_pro',
  },
})
