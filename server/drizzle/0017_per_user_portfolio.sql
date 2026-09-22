-- Per-user paper trading: stars, account and positions were global singletons, so
-- every owner login saw the same portfolio. Key all three by the verified owner
-- email from the auth token. Existing data is assigned to the primary owner.
ALTER TABLE "guidance_stars" ADD COLUMN IF NOT EXISTS "user_email" text NOT NULL DEFAULT 'owner@localhost';
--> statement-breakpoint
ALTER TABLE "guidance_stars" ALTER COLUMN "user_email" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "guidance_stars" DROP CONSTRAINT IF EXISTS "guidance_stars_pkey";
--> statement-breakpoint
ALTER TABLE "guidance_stars" ADD PRIMARY KEY ("user_email", "symbol");
--> statement-breakpoint
ALTER TABLE "guidance_pt_account" ADD COLUMN IF NOT EXISTS "user_email" text NOT NULL DEFAULT 'owner@localhost';
--> statement-breakpoint
ALTER TABLE "guidance_pt_account" ALTER COLUMN "user_email" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "guidance_pt_account" DROP CONSTRAINT IF EXISTS "guidance_pt_account_pkey";
--> statement-breakpoint
ALTER TABLE "guidance_pt_account" ADD PRIMARY KEY ("user_email");
--> statement-breakpoint
ALTER TABLE "guidance_pt_account" DROP COLUMN IF EXISTS "id";
--> statement-breakpoint
ALTER TABLE "guidance_pt_positions" ADD COLUMN IF NOT EXISTS "user_email" text NOT NULL DEFAULT 'owner@localhost';
--> statement-breakpoint
ALTER TABLE "guidance_pt_positions" ALTER COLUMN "user_email" DROP DEFAULT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ptpos_user" ON "guidance_pt_positions" ("user_email");
