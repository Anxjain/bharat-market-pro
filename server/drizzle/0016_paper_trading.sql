-- Paper trading (mock money) for the private guidance desk: a personal starred
-- watchlist + a broker-style mock portfolio (buys, stop-loss/target, EOD fills).
-- No real money anywhere — this measures "what if I had actually invested".
CREATE TABLE IF NOT EXISTS "guidance_stars" (
        "symbol" text PRIMARY KEY NOT NULL,
        "starred_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guidance_pt_account" (
        "id" integer PRIMARY KEY NOT NULL,
        "starting_capital" double precision NOT NULL,
        "cash" double precision NOT NULL,
        "created_at" text NOT NULL,
        "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guidance_pt_positions" (
        "id" serial PRIMARY KEY NOT NULL,
        "symbol" text NOT NULL,
        "qty" integer NOT NULL,
        "entry_price" double precision NOT NULL,
        "entry_date" text NOT NULL,
        "placed_at" text NOT NULL,
        "stop_loss" double precision,
        "target" double precision,
        "tier_at_entry" text,
        "score_at_entry" double precision,
        "notes" text,
        "status" text NOT NULL DEFAULT 'open',
        "exit_price" double precision,
        "exit_date" text,
        "exit_reason" text,
        "closed_at" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ptpos_status" ON "guidance_pt_positions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ptpos_symbol" ON "guidance_pt_positions" ("symbol");
