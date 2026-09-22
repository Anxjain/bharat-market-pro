-- Real, sourced listed-insurer KPIs (replaces the old illustrative sample set).
CREATE TABLE IF NOT EXISTS "insurer_kpis" (
	"symbol" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"vnb_margin_pct" double precision,
	"solvency_ratio" double precision,
	"persistency_13m_pct" double precision,
	"combined_ratio_pct" double precision,
	"ape_growth_pct" double precision,
	"embedded_value_cr" double precision,
	"market_share_pct" double precision,
	"period" text NOT NULL,
	"source_url" text,
	"updated_at" text NOT NULL
);
