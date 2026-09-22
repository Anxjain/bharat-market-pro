-- In-app access management for the private investment sections. A row here grants a
-- login access to Investment Guidance + My Investments (their own per-user portfolio).
-- Emails in GUIDANCE_OWNER_EMAILS remain the permanent ADMINS (can manage this table);
-- rows here are regular members, managed from the app without touching the VM.
CREATE TABLE IF NOT EXISTS "guidance_users" (
        "user_email" text PRIMARY KEY NOT NULL,
        "added_by" text NOT NULL,
        "added_at" text NOT NULL
);
