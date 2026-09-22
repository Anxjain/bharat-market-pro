ALTER TABLE "fund_holdings" DROP CONSTRAINT IF EXISTS "fund_holdings_sfin_month_security_pk";--> statement-breakpoint
UPDATE "fund_holdings" SET "category" = '' WHERE "category" IS NULL;--> statement-breakpoint
ALTER TABLE "fund_holdings" ALTER COLUMN "category" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "fund_holdings" ALTER COLUMN "category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fund_holdings" ADD CONSTRAINT "fund_holdings_sfin_month_security_category_pk" PRIMARY KEY("sfin","month","security","category");