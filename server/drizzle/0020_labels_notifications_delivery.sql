-- The measurement loop + sell advisor substrate:
--   • prices.deliv_pct — NSE delivery percentage (real accumulation vs intraday churn)
--   • guidance_labels — forward outcomes per (symbol, date): raw and NIFTY-excess returns
--     at 5/20/60 sessions. This is what grades every signal and trains the ML ranker.
--   • guidance_notifications — per-user sell/risk advisories on paper positions.
ALTER TABLE "prices" ADD COLUMN IF NOT EXISTS "deliv_pct" double precision;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guidance_labels" (
        "symbol" text NOT NULL,
        "date" text NOT NULL,
        "r5" double precision,
        "r20" double precision,
        "r60" double precision,
        "x5" double precision,
        "x20" double precision,
        "x60" double precision,
        "computed_at" text NOT NULL,
        CONSTRAINT "guidance_labels_pk" PRIMARY KEY ("symbol", "date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_glabels_date" ON "guidance_labels" ("date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guidance_notifications" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_email" text NOT NULL,
        "position_id" integer,
        "symbol" text NOT NULL,
        "kind" text NOT NULL,
        "severity" text NOT NULL,
        "title" text NOT NULL,
        "body" text NOT NULL,
        "fact" text,
        "created_at" text NOT NULL,
        "read_at" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gnotif_user_created" ON "guidance_notifications" ("user_email", "created_at");
