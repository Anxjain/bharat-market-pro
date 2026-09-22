// Drizzle schema for Bharat Market Pro (PostgreSQL).
//
// Design note on column types: every ISO date/time value is stored as `text`
// (not `timestamp`) on purpose. The HTTP API returns these exact strings to the
// frontend, and storing them as text guarantees byte-identical JSON shapes after
// the SQLite→Postgres migration (a `timestamp` column would round-trip as a
// Date and change the serialization). Booleans that were 0/1 integers in SQLite
// become real `boolean`s; the API mappers convert as before.

import { pgTable, text, doublePrecision, bigint, boolean, serial, integer, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'

// ——— NIFTY 500 instruments master ———
export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(),
  name: text('name').notNull(),
  industry: text('industry').notNull(),
  isin: text('isin'),
  domain: text('domain'), // company website host → favicon/logo CDN
})

// ——— Equity EOD OHLCV ———
export const prices = pgTable(
  'prices',
  {
    symbol: text('symbol').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
    volume: bigint('volume', { mode: 'number' }).notNull(),
    delivPct: doublePrecision('deliv_pct'), // NSE delivery % — real accumulation vs churn
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] }), index('idx_prices_date').on(t.date)],
)

// ——— Index EOD closes ———
export const indexPrices = pgTable(
  'index_prices',
  {
    name: text('name').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    open: doublePrecision('open'),
    high: doublePrecision('high'),
    low: doublePrecision('low'),
    close: doublePrecision('close').notNull(),
  },
  (t) => [primaryKey({ columns: [t.name, t.date] })],
)

// ——— Key/value app metadata (e.g. lastIngest) ———
export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

// ——— Price alerts ———
export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  condition: text('condition').notNull(), // 'above' | 'below'
  price: doublePrecision('price').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: text('created_at').notNull(),
  triggeredAt: text('triggered_at'),
  triggerPrice: doublePrecision('trigger_price'),
})

// ——— Company fact sheets (screener.in, cached) ———
export const factSheets = pgTable('fact_sheets', {
  symbol: text('symbol').primaryKey(),
  json: text('json').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ——— NSE corporate filings ———
export const filings = pgTable(
  'filings',
  {
    id: text('id').primaryKey(), // hash of link
    exchange: text('exchange').notNull(),
    symbol: text('symbol'),
    company: text('company').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    filedAt: text('filed_at').notNull(), // ISO
    link: text('link').notNull(),
    summary: text('summary'), // AI digest (null until enriched)
    materiality: text('materiality').notNull().default('medium'),
    ai: boolean('ai').notNull().default(false),
  },
  (t) => [
    index('idx_filings_date').on(t.filedAt),
    // Backs the guidance per-symbol, time-windowed thesis-breaker query (H-11).
    index('idx_filings_symbol_date').on(t.symbol, t.filedAt),
  ],
)

// ——— AI desk notes per company ———
export const deskNotes = pgTable('desk_notes', {
  symbol: text('symbol').primaryKey(),
  note: text('note').notNull(),
  ai: boolean('ai').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ——— Listed-insurer KPIs (REAL, sourced) — replaces the old illustrative sample set.
// Low-volume, quarterly cadence: seeded from insurers' investor presentations / IRDAI,
// each row carrying the reporting period + a source URL so it's auditable (never mock).
export const insurerKpis = pgTable('insurer_kpis', {
  symbol: text('symbol').primaryKey(), // NSE symbol, e.g. 'HDFCLIFE'
  type: text('type').notNull(), // 'Life' | 'General' | 'Health'
  vnbMarginPct: doublePrecision('vnb_margin_pct'), // life only
  solvencyRatio: doublePrecision('solvency_ratio'),
  persistency13mPct: doublePrecision('persistency_13m_pct'), // life only
  combinedRatioPct: doublePrecision('combined_ratio_pct'), // general/health only
  apeGrowthPct: doublePrecision('ape_growth_pct'),
  embeddedValueCr: doublePrecision('embedded_value_cr'),
  marketSharePct: doublePrecision('market_share_pct'),
  period: text('period').notNull(), // reporting period, e.g. 'Q4 FY25' / 'FY25'
  sourceUrl: text('source_url'), // where the figures came from (auditable)
  updatedAt: text('updated_at').notNull(),
})

// ——— Rule-based custom alerts (9.7) — alerts beyond simple price thresholds ———
// A rule is a named set of AND-ed conditions over price/volume/news/filings
// (validated JSON, see alert-rules.ts) evaluated nightly against the bhavcopy.
export const alertRules = pgTable('alert_rules', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  conditions: jsonb('conditions').$type<unknown>().notNull(),
  createdAt: text('created_at').notNull(),
})

// One row per (rule, symbol, session) match. The unique index makes evaluator
// re-runs idempotent; `notified` tracks whether the hit made it into an email.
export const alertRuleHits = pgTable(
  'alert_rule_hits',
  {
    id: serial('id').primaryKey(),
    ruleId: integer('rule_id').notNull(),
    symbol: text('symbol').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD session the rule matched on
    detail: jsonb('detail').$type<unknown>().notNull().default({}),
    notified: boolean('notified').notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_arh_rule_symbol_date').on(t.ruleId, t.symbol, t.date)],
)

// ——— NEW: durable news store (accumulates beyond the in-memory cache) ———
export const news = pgTable(
  'news',
  {
    id: serial('id').primaryKey(),
    dedupKey: text('dedup_key').notNull(), // stable id derived from the headline
    headline: text('headline').notNull(),
    source: text('source').notNull(),
    publishedAt: text('published_at').notNull(), // ISO
    tickers: jsonb('tickers').$type<string[]>().notNull().default([]),
    sentiment: text('sentiment').notNull(), // positive | negative | neutral
    sentimentScore: doublePrecision('sentiment_score').notNull(),
    tier: text('tier').notNull(), // press | exchange
    summary: text('summary'),
    link: text('link'),
    firstSeenAt: text('first_seen_at').notNull(), // ISO — when we first persisted it
  },
  (t) => [
    uniqueIndex('uq_news_dedup').on(t.dedupKey),
    index('idx_news_published').on(t.publishedAt),
    // GIN index so the per-symbol `tickers @> [...]` lookup (guidance developments)
    // is an index scan, not a seq scan over an ever-growing table.
    index('idx_news_tickers').using('gin', t.tickers),
  ],
)

// ——— NEW: quote history (accumulates each fetched delayed quote) ———
export const quotesHistory = pgTable(
  'quotes_history',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(), // the quote key (equity symbol or index alias)
    price: doublePrecision('price').notNull(),
    changePct: doublePrecision('change_pct'),
    ts: text('ts').notNull(), // ISO timestamp of capture
  },
  (t) => [index('idx_quotes_symbol_ts').on(t.symbol, t.ts)],
)

// ——————————————————————————————————————————————————————————————
// ULIP fund aggregator (Phase 3): insurers -> sources (raw archive) -> funds
// and their returns / allocations / holdings. Keyed by SFIN + month. SFIN's
// last 3 digits are the insurer's IRDAI code (HDFC 101, Tata AIA 110).
// ——————————————————————————————————————————————————————————————

// One row per insurer; adapter_id wires it to its pipeline config module.
export const insurers = pgTable('insurers', {
  irdaiCode: text('irdai_code').primaryKey(), // e.g. '101' (HDFC), '110' (Tata AIA)
  name: text('name').notNull(),
  website: text('website'),
  adapterId: text('adapter_id').notNull(),
  status: text('status').notNull().default('active'),
})

// RAW-FIRST archive ledger: one row per source document fetched for an insurer/
// month/kind, recorded BEFORE parsing so re-runs parse from disk, not the network.
export const sources = pgTable(
  'sources',
  {
    insurer: text('insurer').notNull(), // irdai_code
    month: text('month').notNull(), // YYYY-MM
    kind: text('kind').notNull(), // 'combined' | 'fund:<slug>' — discriminates per-fund PDFs
    rawPath: text('raw_path').notNull(),
    url: text('url'),
    sha256: text('sha256').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    parseStatus: text('parse_status').notNull().default('archived'), // archived | stored | failed
  },
  // The (insurer,month,kind) PK already covers (insurer,month) prefix lookups —
  // the old idx_sources_insurer_month was redundant and was dropped.
  (t) => [primaryKey({ columns: [t.insurer, t.month, t.kind] })],
)

// One row per fund per month (the headline sheet).
export const funds = pgTable(
  'funds',
  {
    sfin: text('sfin').notNull(),
    month: text('month').notNull(), // YYYY-MM
    insurer: text('insurer').notNull(), // irdai_code (== sfin.slice(-3))
    name: text('name').notNull(),
    class: text('class'), // 'Individual' | 'Pension'
    category: text('category'),
    nav: doublePrecision('nav'),
    inception: text('inception'),
    benchmark: text('benchmark'),
    manager: text('manager'),
    // Fund Details extras printed on the factsheet (debt funds carry YTM/MD; the
    // managed-summary is the "Equity-6 | Debt-0 | Balanced-3" line next to managers).
    ytm: doublePrecision('ytm'),                 // yield to maturity (%) — debt funds
    modifiedDuration: doublePrecision('modified_duration'), // years — debt funds
    managedSummary: text('managed_summary'),     // e.g. "Equity - 6 | Debt - 0 | Balanced -3"
    aumEquity: doublePrecision('aum_equity'),
    aumDebt: doublePrecision('aum_debt'),
    aumMmi: doublePrecision('aum_mmi'),
    aumTotal: doublePrecision('aum_total'),
    aumUnit: text('aum_unit'), // original printed unit: 'lakh' | 'crore'
    // Canonical AUM in INR Crore (cross-insurer comparable; originals kept above).
    aumEquityCr: doublePrecision('aum_equity_cr'),
    aumDebtCr: doublePrecision('aum_debt_cr'),
    aumMmiCr: doublePrecision('aum_mmi_cr'),
    aumTotalCr: doublePrecision('aum_total_cr'),
    // Deterministic validation outcome (Phase 4).
    status: text('status').notNull().default('clean'), // clean | suspicious | failed(quarantined)
    confidence: doublePrecision('confidence'),
    flags: jsonb('flags').$type<{ code: string; severity: string; message: string }[]>().notNull().default([]),
    // Per-field extraction coverage ledger (shown in the freshness section): each
    // field -> 'present' | 'absent' (checked, not published) | 'partial'.
    coverage: jsonb('coverage').$type<Record<string, string>>().notNull().default({}),
    // Source-link resolution (populated by the ulip:source-pages detection script):
    //  • sourceKind = the sources.kind row this fund maps to ('combined'/'performance'
    //    for whole-month PDFs, or 'fund:<slug>' for per-fund PDFs like Tata AIA).
    //  • sourcePage = 1-based page in that PDF where this fund's factsheet starts
    //    (1 for per-fund PDFs; detected page for combined PDFs; null if unknown).
    sourceKind: text('source_kind'),
    sourcePage: integer('source_page'),
    // Which brain produced this row: 'python' (deterministic pdftotext parser),
    // 'gemini' (LLM extraction), or 'fixture' (dev stub). Lets readers distinguish
    // trusted extractions from fallbacks (a fixture must never masquerade as real).
    extractedVia: text('extracted_via'),
  },
  (t) => [primaryKey({ columns: [t.sfin, t.month] }), index('idx_funds_insurer_month').on(t.insurer, t.month)],
)

// Trailing returns vs benchmark, one row per period.
export const fundReturns = pgTable(
  'fund_returns',
  {
    sfin: text('sfin').notNull(),
    month: text('month').notNull(),
    period: text('period').notNull(), // '1M','6M','1Y','Inception',...
    returnPct: doublePrecision('return_pct'),
    benchmarkPct: doublePrecision('benchmark_pct'),
  },
  (t) => [primaryKey({ columns: [t.sfin, t.month, t.period] })],
)

// Asset / sector weights and F&U mandate bands.
export const fundAllocations = pgTable(
  'fund_allocations',
  {
    sfin: text('sfin').notNull(),
    month: text('month').notNull(),
    kind: text('kind').notNull(), // 'asset' | 'sector' | 'fnu'
    label: text('label').notNull(),
    weight: doublePrecision('weight'), // actual %  (null allowed for pure F&U band rows)
    fuMin: doublePrecision('fu_min'), // F&U mandate lower bound (%)
    fuMax: doublePrecision('fu_max'), // F&U mandate upper bound (%)
  },
  (t) => [primaryKey({ columns: [t.sfin, t.month, t.kind, t.label] })],
)

// Portfolio holdings, one row per security.
export const fundHoldings = pgTable(
  'fund_holdings',
  {
    sfin: text('sfin').notNull(),
    month: text('month').notNull(),
    security: text('security').notNull(),
    weightPct: doublePrecision('weight_pct'),
    normalizedSymbol: text('normalized_symbol'), // resolved NSE symbol, if matched
    // Full categorized portfolio (IRDAI monthly disclosure + factsheet).
    // category is part of the PK: a security can legitimately appear in TWO sections of one
    // fund (e.g. a name held as both Equity and a Bond), and each section has its own
    // "Others" aggregate row — collapsing on (sfin,month,security) alone would lose them.
    category: text('category').notNull().default(''), // verbatim factsheet section label (NO normalization)
    rawCategory: text('raw_category'),  // the bank's own section label, verbatim (same value as category)
    // ISIN is part of the PK (default '' when unpublished): two distinct instruments
    // printed with the SAME name in the SAME section (common in G-Sec/bond lists,
    // different maturities) must not collapse onto one row. '' keeps single-name funds
    // (no ISIN) behaving exactly as before.
    isin: text('isin').notNull().default(''),
    rating: text('rating'),             // credit rating (debt) / industry tag where published
    marketValue: doublePrecision('market_value'), // market value as printed (fund's AUM unit)
  },
  (t) => [primaryKey({ columns: [t.sfin, t.month, t.security, t.category, t.isin] })],
)

// Security name -> NSE symbol alias map (drives holdings normalization).
export const securityAliases = pgTable('security_aliases', {
  alias: text('alias').primaryKey(), // lowercased security name
  symbol: text('symbol').notNull(),
})

// ——————————————————————————————————————————————————————————————
// Optional accounts (Phase 7): watchlist sync only. Identity is managed by an
// external provider (Supabase Auth); we store just the user id (JWT sub) + email
// and their saved symbols. No passwords, no other gating.
// ——————————————————————————————————————————————————————————————
export const watchlists = pgTable('watchlists', {
  userId: text('user_id').primaryKey(), // Supabase auth user id (JWT sub)
  email: text('email'),
  symbols: jsonb('symbols').$type<string[]>().notNull().default([]),
  updatedAt: text('updated_at').notNull(),
})

// ——————————————————————————————————————————————————————————————
// Investment Guidance desk (PRIVATE — owner-only, gated by GUIDANCE_ENABLED).
// Fully isolated from the public app: own tables, own /api/guidance sub-app, no
// public surface. Unlike the public read-only terminal, this section is allowed to
// take a stance — but always alongside its factor stack + a measured base rate.
// ——————————————————————————————————————————————————————————————

// Curated, owner-configurable watch universe. One row per symbol.
export const guidanceWatchlist = pgTable('guidance_watchlist', {
  symbol: text('symbol').primaryKey(), // NSE symbol, e.g. 'SBIN'
  sectorThesis: text('sector_thesis'), // why it's watched (free note)
  tags: jsonb('tags').$type<string[]>().notNull().default([]), // e.g. ['psu','financials']
  active: boolean('active').notNull().default(true),
  addedAt: text('added_at').notNull(), // ISO
})

// Tunable model config: factor weights, setup thresholds, tier cutoffs. One row per key.
export const guidanceConfig = pgTable('guidance_config', {
  key: text('key').primaryKey(), // 'weights' | 'thresholds' | 'tiers'
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Deep daily price history (multi-year) for base-rate computation. Kept SEPARATE from
// the 500-universe `prices` table (which holds only the recently-ingested window) so the
// deep backfill never disturbs the daily ingest. Populated from Yahoo per symbol (and
// optionally an NSE bhavcopy historical backfill). The base-rate engine reads the deepest
// series available per symbol (this table first, then `prices`).
export const guidancePriceHistory = pgTable(
  'guidance_price_history',
  {
    symbol: text('symbol').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    open: doublePrecision('open'),
    high: doublePrecision('high'),
    low: doublePrecision('low'),
    close: doublePrecision('close').notNull(),
    volume: bigint('volume', { mode: 'number' }),
    source: text('source').notNull().default('yahoo'),
  },
  // PK on (symbol,date) already serves the (symbol,date) lookups — the old
  // idx_ghist_symbol_date was a redundant duplicate and was dropped.
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
)

// Audit cache of a computed guidance signal — keeps the page fast AND makes every past
// recommendation auditable (what the model said, and on what evidence, at a point in time).
export const guidanceSnapshots = pgTable(
  'guidance_snapshots',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    asOf: text('as_of').notNull(), // ISO timestamp computed
    dataDate: text('data_date'), // latest price date the signal was computed on
    score: doublePrecision('score'),
    tier: text('tier'), // 'high-conviction' | 'constructive' | 'neutral' | 'avoid'
    factors: jsonb('factors').$type<unknown>().notNull().default([]),
    baserate: jsonb('baserate').$type<unknown>().notNull().default({}),
    analyst: jsonb('analyst').$type<unknown>(),
  },
  (t) => [index('idx_gsnap_symbol_asof').on(t.symbol, t.asOf)],
)

// Quarterly/annual results trend per symbol (screener), cached in the DB so it
// accumulates and isn't re-scraped on every view.
export const guidanceResults = pgTable('guidance_results', {
  symbol: text('symbol').primaryKey(),
  json: jsonb('json').$type<unknown>().notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Cached business-fundamentals (screener P&L/BS/CF/ratios → quality/health/valuation
// block scores) per symbol. DB-persisted; fundamentals change quarterly so it refreshes
// weekly at most. Feeds the "business quality" axis (separate from the price/timing axis).
export const guidanceFundamentals = pgTable('guidance_fundamentals', {
  symbol: text('symbol').primaryKey(),
  json: jsonb('json').$type<unknown>().notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Point-in-time fundamentals snapshots — APPENDED (never overwritten) on each refresh
// so a real history accumulates. This is the substrate that makes threshold/quality
// calibration possible later (the single-row `guidance_fundamentals` above is just the
// latest cache; this table is the ledger).
export const guidanceFundamentalsHistory = pgTable(
  'guidance_fundamentals_history',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    asOf: text('as_of').notNull(), // ISO timestamp captured
    json: jsonb('json').$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_gfh_symbol_asof').on(t.symbol, t.asOf)],
)

// Persisted output of each background opportunity scan (the ranked "best today" board
// + today's movers). One row per run, keyed by the run timestamp, so a week of boards
// accumulates for the "if not today, this week" view.
export const guidanceBoard = pgTable(
  'guidance_board',
  {
    asOf: text('as_of').primaryKey(), // ISO timestamp of the scan run
    json: jsonb('json').$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_gboard_created').on(t.createdAt)],
)

// 9.5: point-in-time index membership — an append-only ledger of NIFTY 500 add/remove
// events (from NSE Indices press releases). Today's members live in `instruments`;
// replaying this ledger BACKWARD from today reconstructs the universe as-of any past
// date, so base rates stop conditioning on survivors. Idempotent via the unique key.
export const indexMembership = pgTable(
  'index_membership',
  {
    id: serial('id').primaryKey(),
    indexName: text('index_name').notNull().default('NIFTY500'),
    symbol: text('symbol').notNull(),
    action: text('action').notNull(), // 'add' | 'remove'
    effectiveDate: text('effective_date').notNull(), // YYYY-MM-DD (w.e.f. date)
    source: text('source').notNull(), // press-release URL / seed label (auditable)
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('uq_index_membership_change').on(t.indexName, t.symbol, t.action, t.effectiveDate)],
)

// ——————————————————————————————————————————————————————————————
// Paper trading (mock money, owner-only). A personal starred list + a broker-style
// mock portfolio PER USER (keyed by the verified owner email from the auth token):
// buy with mock cash at real prices, set stop-loss/target, and measure "what would
// this be worth if I had actually invested that day".
// ——————————————————————————————————————————————————————————————

// In-app access grants for the private investment sections. A row = this login may use
// Investment Guidance + My Investments. GUIDANCE_OWNER_EMAILS stays the admin list
// (permanent, env-managed); this table is managed from the app's admin panel.
export const guidanceUsers = pgTable('guidance_users', {
  userEmail: text('user_email').primaryKey(),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(), // ISO
})

// The measurement loop: forward outcomes per (symbol, date) — raw and NIFTY-excess
// returns at 5/20/60 sessions. Appended nightly, backfilled from deep history. This is
// what grades every signal the desk makes and trains the ML ranker: predictions without
// labels are opinions.
export const guidanceLabels = pgTable(
  'guidance_labels',
  {
    symbol: text('symbol').notNull(),
    date: text('date').notNull(), // the "as of" session (YYYY-MM-DD)
    r5: doublePrecision('r5'), // forward raw return %, 5 sessions
    r20: doublePrecision('r20'),
    r60: doublePrecision('r60'),
    x5: doublePrecision('x5'), // forward EXCESS return % vs NIFTY 50 over the same window
    x20: doublePrecision('x20'),
    x60: doublePrecision('x60'),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] }), index('idx_glabels_date').on(t.date)],
)

// Per-user sell/risk advisories on paper positions (the "when to get out" engine).
export const guidanceNotifications = pgTable(
  'guidance_notifications',
  {
    id: serial('id').primaryKey(),
    userEmail: text('user_email').notNull(),
    positionId: integer('position_id'),
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull(), // trailing-drawdown | thesis-breaker | earnings | horizon-review | ltcg
    severity: text('severity').notNull(), // info | warn | urgent
    title: text('title').notNull(),
    body: text('body').notNull(),
    fact: text('fact'), // the evidence line: number + date + source, house style
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
  },
  (t) => [index('idx_gnotif_user_created').on(t.userEmail, t.createdAt)],
)

// Signed-in visitor ledger — every authenticated request touches this, so the admin
// panel can list registered users who are awaiting access approval.
export const guidanceSeenUsers = pgTable('guidance_seen_users', {
  userEmail: text('user_email').primaryKey(),
  firstSeen: text('first_seen').notNull(),
  lastSeen: text('last_seen').notNull(),
})

// Starred from the guidance detail panel — each user's private investment watchlist.
export const guidanceStars = pgTable(
  'guidance_stars',
  {
    userEmail: text('user_email').notNull(),
    symbol: text('symbol').notNull(),
    starredAt: text('starred_at').notNull(), // ISO
  },
  (t) => [primaryKey({ columns: [t.userEmail, t.symbol] })],
)

// One mock account per user. Cash moves on every fill.
export const guidancePtAccount = pgTable('guidance_pt_account', {
  userEmail: text('user_email').primaryKey(),
  startingCapital: doublePrecision('starting_capital').notNull(),
  cash: doublePrecision('cash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// One row per buy (a lot), owned by a user. A partial sell splits the lot; stop-loss/
// target hits are applied by the daily sweep on real OHLC bars and record exit_reason.
export const guidancePtPositions = pgTable(
  'guidance_pt_positions',
  {
    id: serial('id').primaryKey(),
    userEmail: text('user_email').notNull(),
    symbol: text('symbol').notNull(),
    qty: integer('qty').notNull(),
    entryPrice: doublePrecision('entry_price').notNull(),
    entryDate: text('entry_date').notNull(), // price date the fill used (YYYY-MM-DD)
    placedAt: text('placed_at').notNull(), // wall-clock ISO when the order was placed
    stopLoss: doublePrecision('stop_loss'),
    target: doublePrecision('target'),
    tierAtEntry: text('tier_at_entry'), // guidance tier snapshot at entry (auditable)
    scoreAtEntry: doublePrecision('score_at_entry'),
    notes: text('notes'),
    status: text('status').notNull().default('open'), // 'open' | 'closed'
    exitPrice: doublePrecision('exit_price'),
    exitDate: text('exit_date'),
    exitReason: text('exit_reason'), // 'manual' | 'stop-loss' | 'target'
    closedAt: text('closed_at'),
  },
  (t) => [index('idx_ptpos_status').on(t.status), index('idx_ptpos_symbol').on(t.symbol), index('idx_ptpos_user').on(t.userEmail)],
)
