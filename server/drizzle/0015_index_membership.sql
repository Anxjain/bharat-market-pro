-- 9.5: point-in-time index membership (kill survivorship bias). Append-only ledger of
-- NIFTY 500 add/remove events sourced from NSE Indices press releases, so base rates and
-- calibration can reconstruct the universe as-of any past date instead of conditioning
-- on today's survivors. Idempotent inserts via the unique (index,symbol,action,date) key.
CREATE TABLE IF NOT EXISTS "index_membership" (
	"id" serial PRIMARY KEY NOT NULL,
	"index_name" text DEFAULT 'NIFTY500' NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"effective_date" text NOT NULL,
	"source" text NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_index_membership_change" ON "index_membership" ("index_name","symbol","action","effective_date");
