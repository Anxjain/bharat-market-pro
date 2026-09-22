CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"condition" text NOT NULL,
	"price" double precision NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"triggered_at" text,
	"trigger_price" double precision
);
--> statement-breakpoint
CREATE TABLE "desk_notes" (
	"symbol" text PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"ai" boolean NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_sheets" (
	"symbol" text PRIMARY KEY NOT NULL,
	"json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filings" (
	"id" text PRIMARY KEY NOT NULL,
	"exchange" text NOT NULL,
	"symbol" text,
	"company" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"filed_at" text NOT NULL,
	"link" text NOT NULL,
	"summary" text,
	"materiality" text DEFAULT 'medium' NOT NULL,
	"ai" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "index_prices" (
	"name" text NOT NULL,
	"date" text NOT NULL,
	"open" double precision,
	"high" double precision,
	"low" double precision,
	"close" double precision NOT NULL,
	CONSTRAINT "index_prices_name_date_pk" PRIMARY KEY("name","date")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"symbol" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"industry" text NOT NULL,
	"isin" text,
	"domain" text
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedup_key" text NOT NULL,
	"headline" text NOT NULL,
	"source" text NOT NULL,
	"published_at" text NOT NULL,
	"tickers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sentiment" text NOT NULL,
	"sentiment_score" double precision NOT NULL,
	"tier" text NOT NULL,
	"summary" text,
	"link" text,
	"first_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" bigint NOT NULL,
	CONSTRAINT "prices_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE "quotes_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"price" double precision NOT NULL,
	"change_pct" double precision,
	"ts" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_filings_date" ON "filings" USING btree ("filed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_news_dedup" ON "news" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "idx_news_published" ON "news" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "idx_prices_date" ON "prices" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_quotes_symbol_ts" ON "quotes_history" USING btree ("symbol","ts");