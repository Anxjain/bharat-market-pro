# Investment Guidance — methodology & limitations

A **private, owner-only** decision-support desk inside Bharat Market Pro. Unlike the public,
deliberately-descriptive terminal, this section is allowed to take a stance — but only
ever *alongside* its full evidence: the factor stack (the "why"), a **measured historical
base rate that shows its failures**, and the thesis-breakers. It never prints a bare "BUY".

> Design contract: maximally honest about uncertainty. It may say the evidence points to
> buying; it must **not** assert a forward outcome as fact. Confidence is carried by a
> base rate computed from our own price history (with the misses shown), not by the LLM.

---

## Hard isolation / access

- Gated by `GUIDANCE_ENABLED` (default **false**). When off, `/api/guidance/*` returns **404**
  and the public app is byte-for-byte unchanged. `chat.ts` and public endpoints are untouched.
- Owner-only: `GUIDANCE_OWNER_EMAILS` (comma list) matched against the verified Supabase JWT.
  A non-owner gets **404** (not 403) — the section is never advertised. The nav entry and
  `/guidance` route only appear when `/api/guidance/status` returns 200 for that user.
- `GUIDANCE_DEV_OPEN=true` skips the owner check for **localhost testing only** — never set it
  on a deployed instance.

## Run

```bash
cd server
npm run db:migrate              # applies migration 0007 (also runs on server boot)
npm run guidance:seed           # seed the strategic watchlist + default config
npm run guidance:backfill       # deep Yahoo history for the watchlist (run --all for the universe)
# .env: GUIDANCE_ENABLED=true, GUIDANCE_OWNER_EMAILS=you@example.com (+ GUIDANCE_DEV_OPEN=true to test locally)
```

## Data sources (reused, never re-fetched ad hoc)

| Layer | Source | Notes |
|---|---|---|
| Deep daily prices | Yahoo `…​.NS` `range=max` → `guidance_price_history` | multi-year; the engine reads the **deepest series available** per symbol, falling back to the live `prices` store |
| Live prices | NSE bhavcopy → `prices` (`repositories/prices`) | ~98-day window; the fallback when deep history isn't backfilled yet |
| Filings | `repositories/filings` (NSE disclosure RSS) | catalysts + risk flags |
| News | `fetchLiveNews()` (press RSS) | sentiment, filtered to the ticker |
| Fundamentals | `getFactSheet()` (screener.in, cached) | point-in-time only — see limitations |
| Cohort | curated watchlist **tags** | peers sharing a tag (cleaner than NSE "industry") |

---

## Factor stack (the "why")

Each factor returns `{ code, label, group, value, display, score∈[-1,+1], weight, contribution, source, asOf }`.
`contribution = score × weight` (bullish positive). Weights are tunable in `guidance_config`
(`weights` key, keyed by factor `code`); defaults below are deliberately conservative.

> **Orthogonal blocks (M-G3).** The earlier stack emitted ~10 correlated price/relative/news
> factors that were all restatements of a single mean-reversion prior — one oversold event
> lit ~7 of ~15 weight positive at once, making "constructive" near-automatic. They are now
> collapsed into a few roughly-**orthogonal** blocks, each scored **once** with one weight.
> Cutoffs are carried over as sensible defaults but are **not calibrated** — they should be fit
> against the realized base-rate distribution once enough snapshots accumulate.

**Price / technical** — `drop_1d` (the trigger move; also drives the base-rate band; a moderate idiosyncratic dip is a buy *setup*, a crash <-12% signals something broke), `extension` (how far stretched below trend/52-wk-high = mean-reversion **room**; a very deep drawdown <-45% is a falling knife, not room), `exhaustion` (oversold RSI + a run of down days = sellers spent; a same-day crash flips it negative), `flow` (capitulation **volume** on a down day + abnormal volatility vs NIFTY).

**Relative / peers** — `relative` (is the weakness **idiosyncratic** — fell more than the market/cohort? A clean overreaction with no bad news scores **positive**; the same drop **with** confirming negative news, or with no news while already in a 6-month downtrend, scores **negative** — the block is symmetric, not dip-only).

**Catalyst** — `catalyst_recent`, `catalyst_upcoming` (board-meeting/results intimations, keyed on the parsed **meeting date**, not the filing date), `high_materiality`.

**News / sentiment** — `news_sentiment` (the pure 14-day sentiment signal; the old "price-down-but-news-not-negative" overreaction tell now lives inside `relative`, where it can also cut against the setup).

**Fundamentals** — `valuation_pe`, `quality_roe`, `dividend_yield`, `pros_cons` (screener bull/bear count).

**Risk / structural** (can cap conviction) — `dilution_flag` ★ (QIP/rights/preferential — **breaks** the per-share recovery thesis for financials), `structural_risk` (auditor/rating/pledge/legal), `max_drawdown_hist` ★ (the **Suzlon check**, measured over the **last 4 years only** — a decade-old peak-vs-COVID-trough would mark nearly every Indian name high-risk, so older history doesn't get a vote; vendor split-adjustment seams (±40%/day bars) are rebased, not scored; the factor carries its own fact — peak ₹/date → trough ₹/date — and if <-80% within the window it caps conviction), `downtrend_6m` (value-trap check), `liquidity` (avoid illiquid).

### Composite → tier
`normalized = Σ(scoreᵢ·wᵢ) / Σwᵢ ∈ [-1,+1]` → `score = (normalized+1)/2 × 100`. Tier cutoffs in
`guidance_config.tiers` (default high-conviction ≥65, constructive ≥42, neutral ≥22, else avoid).
**Thesis-breaker cap:** if any `breaksThesis` factor with a negative score fires (dilution,
auditor/rating/legal, catastrophic drawdown history), the score is capped at 34 — it can never
read high-conviction/constructive while a breaker is live.

---

## Base rate (this carries the confidence)

For the **current setup** (the severity band of today's drop), scan our own deep history for
**comparable past setups** and report what actually happened next — *buying the dip*.

- **Comparable setup** = a trading day whose single-session drop falls in the same severity band
  (default bands 3–5 / 5–8 / >8%). Pooled optionally across the curated peer cohort to grow `n`.
- **Forward returns** measured from the dip close, over **10 / 20 / 40 / 60** trading days:
  median, P25/P75, **worst (shown)**, % positive.
- **"Recovered (touched)"** = price traded back to/above the close *before* the move within the
  window. **"Recovered (terminal)"** = the close at horizon *h* was ≥ the pre-move reference:
  the pre-**drop** level for a dip, and the pre-**pop** base for a one-day rise (M-G4 — a
  distinct, weaker bar than `% positive`, which is measured against the popped entry).
- **No active setup (M-G1):** when today's move is inside the normal daily range (below the
  mildest band, e.g. a +2% / −1% day) there is **no** dip/pop to base-rate — the desk returns
  "no active setup" instead of mislabelling it as the mildest drop band.
- **Independence:** overlapping setups within `maxHorizon` of a prior counted one (same symbol) are
  skipped so one episode isn't double-counted.
- **Honesty:** `n` is always shown; `lowConfidence` is set when `n < recoveredMinSamples` (default
  10) both overall **and per horizon** (M-G2 — the longest horizons lose samples fastest). The UI
  renders the distribution, the recovery rates, the **misses**, and the **single worst outcome**
  explicitly. A real "recovered 4 of 6 times, worst −22%" beats a fabricated percentage.
- **⚠ Survivorship bias (H-13, disclosed).** The cohort is drawn from names **still listed today**
  (the current instruments universe + a hand-curated watchlist), so **delisted / suspended /
  distress-merged** names never enter the sample. `positivePct` / `recoveredTerminalPct` are
  therefore biased **upward** and "worst case shown" is really "worst *among survivors*" — most
  optimistic exactly where the desk operates (deep small/mid-cap dip-buys). Treat every number as
  **survivor-conditioned** (the UI labels it as such). Widening to a point-in-time universe that
  includes delisted history is on the roadmap.

---

## Business-quality axis (fundamentals) — kept SEPARATE from timing

The factor stack + base rate above answer "**is now a good entry?**" (timing/setup). A second,
independent axis answers "**is this worth owning at all?**" (business quality). They are shown
side by side and never blended into one opaque number — a great company can be a poor this-week
entry, and a beaten-down bounce can be a weak business.

Sourced from screener.in (already scraped) — its P&L, balance-sheet, cash-flow and ratios
sections, using screener's own pre-computed compounded growth / ROE / CFO-OP where available.
Cached in `guidance_fundamentals` (weekly refresh, last-good on failure). Four blocks, each with
an explainable +/− point list, combined into a **0–100 quality score → tier** (excellent / good /
fair / weak):

- **Quality (growth):** 3Y & 5Y sales and profit CAGR, operating-margin trend.
- **Financial health:** 3Y ROE, ROCE, debt-to-equity + its trend, interest coverage, cash-flow
  quality (operating cash flow vs profit).
- **Valuation:** P/E, PEG, P/B (with the bank ROE-vs-P/B nuance), dividend yield.
- **Risk penalty:** operating-cash-flow-negative-vs-profit, debt spike, weak interest cover — can
  force a "do not recommend".

**Bank overlay:** banks are detected (Revenue / Financing Profit / Deposits layout) and the
inapplicable metrics are skipped (deposit-funded leverage isn't penalised; no OPM). Asset-quality
(GNPA/NNPA/NIM/CAR) is **not available** from screener's standard sections and is honestly flagged
as not captured.

**Policy/execution overlay (renewables / infra / defence / PSU-energy):** for owner-tagged
policy-linked names, a *heuristic* tailwind is credited **only when the company is executing** —
a real recent order/contract win (from filings) or sustained sales growth — never as an assumed
score. If the tailwind is there but execution isn't showing, that is said plainly.

**How it feeds ranking:** quality is an **eligibility gate** on the opportunity board — a
fundamentals "force-avoid" is pushed to the bottom, better businesses get a small lift — so the
board favours *good businesses at good entries*, not just bounces. Both scores (`setup` and `biz`)
are shown on every card, and the plain-English verdict cites the business quality separately from
the entry timing.

> **On calibration:** the fundamental thresholds are sensible heuristic defaults, **not**
> backtested — proper calibration needs *historical* fundamentals, which we don't yet have (each
> scrape is point-in-time). Note that `guidance_fundamentals` is keyed **by symbol** and
> upsert-overwrites, so it holds only the *latest* snapshot — it does **not** accumulate history.
> To build the series needed for calibration, each refresh now **also appends** to an
> append-only `guidance_fundamentals_history (symbol, as_of, json)` table (M-G6). *(Migration
> pending — see the repo note; until it lands the append is best-effort and silently skipped.)*

---

## Where the data contradicts common premises (surfaced, not hidden)

1. **History depth.** The live `prices` store is only ~98 trading days — far too short for real
   base rates (n≈0–5). That's *why* we backfill multi-year Yahoo history; until a name is
   backfilled, its base rate runs on the short window and is flagged low-confidence (`deep:false`).
2. **"This sector can't fall."** `max_drawdown_hist` measures each name's worst drawdown over
   the **last 4 years** (not all-time — 2008/2010-peak-to-COVID comparisons made everything read
   "unbuyable" and said nothing about the name today). A crash within the window still surfaces
   with its exact peak ₹/date → trough ₹/date fact, and <-80% caps conviction. Every readout
   reason now carries a `fact` line (measured number + dates + source link where one exists).
3. **"PSU banks always recover."** The base rate *quantifies* the actual recovery frequency and
   shows the dead-money cases, instead of asserting recovery.
4. **Dilution breaks the financials thesis.** A QIP/rights/preferential filing fires
   `dilution_flag` (a thesis-breaker) and caps the tier — per-share recovery doesn't survive issuance.

## Known limitations (what this signal CAN'T tell you)

- **Not an outcome predictor.** A base rate is a historical frequency; regimes change. Worst cases
  shown *have happened* and can happen again.
- **Fundamentals are point-in-time.** screener.in scrapes give *current* valuation/ROE only — there
  is no historical fundamental series, so we cannot base-rate on valuation, only show context.
- **Catalysts are coarse.** Filing-derived "upcoming results" depends on NSE intimation text; not all
  catalysts are captured. News sentiment is lexicon-based and noisy.
- **Adjusted-close caveat.** Deep history uses Yahoo adjusted close (handles splits/dividends);
  intraday/volume factors use the live store where adjustment differs slightly.
- **Cohort is curated, not exhaustive.** "Sector-wide vs idiosyncratic" reflects the watchlist peers
  sharing a tag, not the full sector.
- **Single-day-drop setups only (v1).** The comparability definition keys on single-session drops;
  multi-day drawdown-band setups are a planned extension.
- **The LLM brief is grounded but fallible.** It may not state probabilities, but it can still
  mis-weight; treat it as a second read of the same factors, not new information.

*Private decision-support for the owner's own capital. Signals are evidence-weighted setups, not
outcome guarantees. Base rates are historical and include the failures.*
