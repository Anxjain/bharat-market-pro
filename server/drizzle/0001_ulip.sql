CREATE TABLE "fund_allocations" (
	"sfin" text NOT NULL,
	"month" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"weight" double precision,
	"fu_min" double precision,
	"fu_max" double precision,
	CONSTRAINT "fund_allocations_sfin_month_kind_label_pk" PRIMARY KEY("sfin","month","kind","label")
);
--> statement-breakpoint
CREATE TABLE "fund_holdings" (
	"sfin" text NOT NULL,
	"month" text NOT NULL,
	"security" text NOT NULL,
	"weight_pct" double precision,
	"normalized_symbol" text,
	CONSTRAINT "fund_holdings_sfin_month_security_pk" PRIMARY KEY("sfin","month","security")
);
--> statement-breakpoint
CREATE TABLE "fund_returns" (
	"sfin" text NOT NULL,
	"month" text NOT NULL,
	"period" text NOT NULL,
	"return_pct" double precision,
	"benchmark_pct" double precision,
	CONSTRAINT "fund_returns_sfin_month_period_pk" PRIMARY KEY("sfin","month","period")
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"sfin" text NOT NULL,
	"month" text NOT NULL,
	"insurer" text NOT NULL,
	"name" text NOT NULL,
	"class" text,
	"category" text,
	"nav" double precision,
	"inception" text,
	"benchmark" text,
	"manager" text,
	"aum_equity" double precision,
	"aum_debt" double precision,
	"aum_mmi" double precision,
	"aum_total" double precision,
	CONSTRAINT "funds_sfin_month_pk" PRIMARY KEY("sfin","month")
);
--> statement-breakpoint
CREATE TABLE "insurers" (
	"irdai_code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"adapter_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"insurer" text NOT NULL,
	"month" text NOT NULL,
	"kind" text NOT NULL,
	"raw_path" text NOT NULL,
	"url" text,
	"sha256" text NOT NULL,
	"fetched_at" text NOT NULL,
	"parse_status" text DEFAULT 'archived' NOT NULL,
	CONSTRAINT "sources_insurer_month_kind_pk" PRIMARY KEY("insurer","month","kind")
);
--> statement-breakpoint
CREATE INDEX "idx_funds_insurer_month" ON "funds" USING btree ("insurer","month");--> statement-breakpoint
CREATE INDEX "idx_sources_insurer_month" ON "sources" USING btree ("insurer","month");