-- Signed-in visitor ledger: every authenticated request records its (verified) email,
-- so the admin panel can show signups awaiting approval — the panel previously only
-- listed already-granted members, so new registrations were invisible. Backfilled from
-- the public watchlist-sync table (the only place logins were recorded until now).
CREATE TABLE IF NOT EXISTS "guidance_seen_users" (
        "user_email" text PRIMARY KEY NOT NULL,
        "first_seen" text NOT NULL,
        "last_seen" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "guidance_seen_users" ("user_email", "first_seen", "last_seen")
        SELECT lower("email"), min("updated_at"), max("updated_at")
        FROM "watchlists"
        WHERE "email" IS NOT NULL AND "email" <> ''
        GROUP BY lower("email")
ON CONFLICT ("user_email") DO NOTHING;
