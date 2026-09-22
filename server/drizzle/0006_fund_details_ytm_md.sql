ALTER TABLE "funds" ADD COLUMN "ytm" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "modified_duration" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "managed_summary" text;