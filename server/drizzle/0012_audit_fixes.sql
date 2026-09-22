-- Audit fixes (2026-07-02): index hygiene, news GIN, funds provenance,
-- holdings ISIN in PK, and the point-in-time fundamentals history ledger.

-- M-B15: drop redundant indexes (each duplicates an existing primary key).
DROP INDEX IF EXISTS "idx_ghist_symbol_date";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sources_insurer_month";--> statement-breakpoint

-- M-B5: GIN index for the per-symbol `tickers @> [...]` news lookup.
CREATE INDEX IF NOT EXISTS "idx_news_tickers" ON "news" USING gin ("tickers");--> statement-breakpoint

-- H-11: composite index backing the guidance per-symbol filings query.
CREATE INDEX IF NOT EXISTS "idx_filings_symbol_date" ON "filings" ("symbol","filed_at");--> statement-breakpoint

-- H-9: record which extraction brain produced each fund row.
ALTER TABLE "funds" ADD COLUMN IF NOT EXISTS "extracted_via" text;--> statement-breakpoint

-- M-U7: ISIN becomes part of the holdings PK so two distinct instruments printed
-- with the same name in the same section don't collapse. '' for unpublished ISINs.
UPDATE "fund_holdings" SET "isin" = '' WHERE "isin" IS NULL;--> statement-breakpoint
ALTER TABLE "fund_holdings" ALTER COLUMN "isin" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "fund_holdings" ALTER COLUMN "isin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fund_holdings" DROP CONSTRAINT IF EXISTS "fund_holdings_sfin_month_security_category_pk";--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD CONSTRAINT "fund_holdings_sfin_month_security_category_isin_pk" PRIMARY KEY("sfin","month","security","category","isin");--> statement-breakpoint

-- M-G6: append-only fundamentals history (the calibration substrate).
CREATE TABLE IF NOT EXISTS "guidance_fundamentals_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"as_of" text NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gfh_symbol_asof" ON "guidance_fundamentals_history" ("symbol","as_of");
