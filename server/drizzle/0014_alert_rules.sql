-- Rule-based custom alerts engine (9.7): user-defined condition sets over
-- price/volume/news/filings, evaluated nightly against the fresh bhavcopy.
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"conditions" jsonb NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rule_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
-- Re-running an evaluation for the same session must be a no-op (idempotent inserts).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_arh_rule_symbol_date" ON "alert_rule_hits" ("rule_id","symbol","date");
