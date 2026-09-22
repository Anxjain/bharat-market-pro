CREATE TABLE "guidance_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidance_price_history" (
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"open" double precision,
	"high" double precision,
	"low" double precision,
	"close" double precision NOT NULL,
	"volume" bigint,
	"source" text DEFAULT 'yahoo' NOT NULL,
	CONSTRAINT "guidance_price_history_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE "guidance_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"as_of" text NOT NULL,
	"data_date" text,
	"score" double precision,
	"tier" text,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baserate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"analyst" jsonb
);
--> statement-breakpoint
CREATE TABLE "guidance_watchlist" (
	"symbol" text PRIMARY KEY NOT NULL,
	"sector_thesis" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ghist_symbol_date" ON "guidance_price_history" USING btree ("symbol","date");--> statement-breakpoint
CREATE INDEX "idx_gsnap_symbol_asof" ON "guidance_snapshots" USING btree ("symbol","as_of");