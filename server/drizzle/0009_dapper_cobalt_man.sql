CREATE TABLE "guidance_board" (
	"as_of" text PRIMARY KEY NOT NULL,
	"json" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_gboard_created" ON "guidance_board" USING btree ("created_at");