CREATE TABLE "watchlists" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" text NOT NULL
);
