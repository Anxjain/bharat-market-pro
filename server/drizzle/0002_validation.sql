ALTER TABLE "funds" ADD COLUMN "aum_unit" text;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "aum_equity_cr" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "aum_debt_cr" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "aum_mmi_cr" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "aum_total_cr" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "status" text DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "confidence" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "flags" jsonb DEFAULT '[]'::jsonb NOT NULL;