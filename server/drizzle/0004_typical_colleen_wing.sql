ALTER TABLE "fund_holdings" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD COLUMN "raw_category" text;--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD COLUMN "isin" text;--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD COLUMN "rating" text;--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD COLUMN "market_value" double precision;--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "coverage" jsonb DEFAULT '{}'::jsonb NOT NULL;