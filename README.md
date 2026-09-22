# Bharat Market Pro

**An Indian equity research terminal and ULIP insurance-fund monitor.**

Bharat Market Pro ingests Indian market data — NSE end-of-day prices, corporate
filings, news, company fundamentals and insurer fact-sheets — into Postgres, and
presents it as a single research desk: company pages, portfolio-level fund
analysis, a grounded AI assistant, and a private, measured investment-guidance
section.

It does two things that a conventional market dashboard does not:

1. **It reads documents that nobody else has structured.** Ten Indian insurers
   publish monthly ULIP fund disclosures as PDFs, in ten incompatible layouts,
   with no API and no standardisation body. A policyholder cannot compare the
   fund their premium actually buys. This project parses those PDFs into
   validated, security-level structured data — **deterministically, with no AI
   model in the loop**.

2. **It grades its own predictions.** Every signal is snapshotted when it is
   made and later scored against what actually happened, using a corpus of
   forward-return labels computed at 5-, 20- and 60-session horizons, both raw
   and relative to the NIFTY index.

Everything runs from **one process** (API + built frontend) plus Postgres. There
is no managed service you cannot swap out, and **no API key is required** — the
entire market-data and fact-sheet pipeline works with no LLM at all.

---

## Contents

1. [Quick start](#quick-start)
2. [The fund-transparency engine](#the-fund-transparency-engine)
3. [The measurement loop](#the-measurement-loop)
4. [Architecture](#architecture)
5. [Data sources](#data-sources)
6. [Configuration](#configuration)
7. [Accounts and the private sections](#accounts-and-the-private-sections)
8. [Working with fact-sheets](#working-with-fact-sheets)
9. [Scheduled jobs](#scheduled-jobs)
10. [Development](#development)
11. [Operations](#operations)
12. [Troubleshooting](#troubleshooting)

---

## Quick start

### Requirements

| | |
|---|---|
| Node.js | 22 or newer |
| PostgreSQL | 16 (or Docker, which provides it) |

Optional — each unlocks one named feature, and nothing else changes without it:

| | Enables | Without it |
|---|---|---|
| Python 3 + `pymupdf` | Offline fact-sheet extraction | Falls back to the AI extractor, which needs a paid key |
| `poppler-utils` (`pdftotext`) | Reading a PDF's text layer | Insurer/month auto-detection on upload is skipped |
| Chromium | Two insurers behind bot protection | Those two can't be fetched automatically (upload still works) |
| A Supabase project | Login, per-user watchlists, private sections | App runs anonymously; watchlists stay in the browser |
| An LLM API key | AI assistant and written summaries | Those panels show "not configured" |

The Docker image installs Python, PyMuPDF, poppler and Chromium for you.

### Option A — Docker

```bash
cp .env.example .env                # build-time + infrastructure settings
cp server/.env.example server/.env  # runtime settings
docker compose up -d --build
```

Open **http://localhost:9787**. Postgres runs in the stack and schema migrations
apply automatically on boot. Leave `DOMAIN` unset to serve plain HTTP.

### Option B — run it directly

```bash
# 1. Postgres — your own, or just this container:
docker run -d --name bharat_market_pro_pg \
  -e POSTGRES_USER=bharat_market_pro -e POSTGRES_PASSWORD=bharat_market_pro \
  -e POSTGRES_DB=bharat_market_pro -p 5433:5432 postgres:16

# 2. Configure
cp server/.env.example server/.env   # DATABASE_URL already matches the container above

# 3. Install
npm install
npm --prefix server install
pip install pymupdf                  # optional: offline fact-sheet extraction

# 4. Build the frontend, then run the server (which also serves it)
npm run build
npm --prefix server run start
```

Open **http://localhost:9787**. For frontend development with hot reload, run
`npm run dev` in a second terminal (Vite on 5174, proxying `/api` to 9787).

### Populating it

The app creates its schema on first boot and runs fine against an empty
database — it just has no history until data accumulates. To fill it:

```bash
npm --prefix server run ingest       # NSE end-of-day prices — run after market close
npm --prefix server run ulip         # monthly insurer fact-sheets
npm --prefix server run guidance:labels   # compute forward-return labels
```

> The research dataset itself (prices, filings, news, fund holdings, labels and
> the source PDFs) is **not** in this repository — it is large binary data and
> is rebuilt by the commands above. `scripts/restore-data.sh` will load a dump
> if you have one.

---

## The fund-transparency engine

ULIP (unit-linked insurance plan) funds hold a large share of Indian long-term
household savings. Unlike mutual funds — which have AMFI standardisation and
machine-readable feeds — ULIP funds have no API, no aggregator and no common
format. Each insurer publishes a monthly PDF in its own layout.

Extraction runs **fully offline**. Each insurer has a dedicated extractor in
`server/extractors/` (Python + PyMuPDF) that reads the PDF's text and vector
layers directly. No AI model, no API key, no quota, and no run-to-run variation:
the same document always produces the same numbers, and a wrong figure traces to
a rule you can fix.

Three things make this harder than "read the text out of a PDF":

- **Reading order destroys tables.** A PDF emits a table's names and its numbers
  as separate blocks, so naive text extraction mis-pairs them. The extractors
  work from word-level coordinates and rebuild each table spatially.
- **The reporting month is not the cover date.** Fact-sheet covers are dated by
  publication month. One insurer's cover reads "June 2026 Edition" while all 36
  of its fund pages report "May 31, 2026". The month is therefore decided by
  majority vote of the "as on" dates across every page.
- **The insurer must come from the data, not the filename.** An SFIN code's last
  three digits are the insurer's IRDAI registration number, printed against
  every fund — so identification is exact rather than a guess.

Everything is validated before it is stored (returns reconciled against NAV
CAGR, allocations summed, weights bounded). Records that fail are quarantined
rather than shown, and a per-fund coverage ledger records whether each field was
present, absent, or partial at the source.

`docs/samples/` contains one extractor output so you can see the shape of the
data without running the pipeline.

---

## The measurement loop

The guidance engine is built so that its claims can be checked:

- **Forward-return labels** at 5, 20 and 60 sessions, computed both raw and
  relative to the index, over the full price history.
- **Point-in-time universe** — index membership is tracked historically, so a
  backtest cannot silently only contain companies that survived.
- **Base rates with their failures shown**, using Wilson score intervals on
  every proportion rather than bare percentages. Financial returns are
  fat-tailed, so empirical intervals are used in preference to tests that assume
  normality.
- **Snapshots at decision time**, so a call is graded against what was knowable
  when it was made.

The methodology, and its limitations, are written up in [GUIDANCE.md](GUIDANCE.md).

---

## Architecture

```
Browser ──► Caddy (TLS, :80/:443) ──► App (:9787) ──► Postgres
                                          │
                                          ├── Python extractors (offline PDF parsing)
                                          ├── Chromium (bot-protected insurer sites)
                                          └── LLM provider (optional)
```

**Frontend** — React + Vite + TypeScript + Tailwind. Built to `server/dist` and
served by the same process as the API, so there is only one thing to deploy.

**Backend** — Node + Hono, run through `tsx`. Entry `server/src/index.ts`.

**Database** — Postgres with Drizzle. Migrations in `server/drizzle/` apply
automatically at boot. All SQL lives in `server/src/repositories/`; route
handlers contain none.

```
src/                    frontend (pages, components, lib)
server/src/
  index.ts              API + static serving
  scheduler.ts          cron jobs
  repositories/         every SQL query
  ulip/                 insurer fact-sheet pipeline
  guidance/             measurement + investment desk
  ingest/               market data ingestion
  ml/                   dataset export
server/extractors/      per-insurer PDF parsers (Python)
server/drizzle/         schema migrations
scripts/                database + ML helper scripts
docs/                   insurer source list, sample extractor output
```

---

## Data sources

All public and free:

- **NSE** — end-of-day price archives, corporate disclosure feeds
- **Yahoo Finance** — quotes, deep history, corporate actions
- **Indian financial press** — RSS
- **screener.in** — company fundamentals and quarterly results
- **Insurer websites** — monthly ULIP fact-sheet PDFs (see [docs/ulip-sources.md](docs/ulip-sources.md))

Each is fetched politely and archived on first retrieval, so re-runs don't
refetch. Check each source's terms against your own use case.

---

## Configuration

Two env files, by design:

- **`.env`** (project root) — build-time and infrastructure. Read by Docker Compose.
- **`server/.env`** — runtime settings and all secrets. Never bundled into the browser build.

### Root `.env`

| Variable | Default | Purpose |
|---|---|---|
| `DOMAIN` | `localhost` | Public hostname. Drives TLS. Leave unset for plain HTTP. |
| `ACME_EMAIL` | — | Let's Encrypt contact address. |
| `PUBLIC_URL` | derived from `DOMAIN` | Base URL used in outgoing email links. |
| `POSTGRES_PASSWORD` | — | **Change this before exposing the app to a network.** |
| `VITE_SUPABASE_URL` | — | Enables login. Baked into the frontend at build time. |
| `VITE_SUPABASE_ANON_KEY` | — | The publishable key. Safe to expose — it is a public key. |

> Vite inlines `VITE_*` at build time, so changing either Supabase value
> requires a **rebuild** (`docker compose up -d --build`), not just a restart.

### `server/.env`

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Postgres connection string. |
| `PORT` | `9787` | API + frontend port. |
| `SUPABASE_URL` | — | Project URL, for verifying login tokens against its public keys. |
| `GUIDANCE_ENABLED` | `false` | Master switch for the private investment sections. |
| `GUIDANCE_OWNER_EMAILS` | — | Comma-separated admin emails. Required in production for admin tools. |
| `GUIDANCE_DEV_OPEN` | `false` | Localhost-only bypass of the admin check. Ignored when `NODE_ENV=production`. |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | — | Optional. AI assistant + written summaries. |
| `ULIP_PYTHON` | `python3` | Interpreter used for the offline fact-sheet extractors. |
| `RAW_DIR` / `ULIP_FACTSHEET_DIR` / `ULIP_INTAKE_DIR` | `./raw` `./factsheets` `./intake` | Where PDFs are archived and picked up. |
| `SCHEDULER_ENABLED` | `true` | Master switch for background jobs. |
| `SCHEDULER_FETCH` | `0` | Set `1` to let scheduled jobs fetch from the internet. |
| `SMTP_*` | — | Optional. Without these, emails are skipped (logged, harmless). |

Full annotated versions are in `.env.example` and `server/.env.example`.
**Neither `.env` file is ever committed** — both are gitignored and excluded
from the Docker image.

---

## Accounts and the private sections

Login is **optional**. Without it the app is fully usable anonymously — the
watchlist just lives in the browser instead of in an account. To enable it,
create a free Supabase project and put its URL + publishable key in the root
`.env`, and its URL in `server/.env`. Tokens are verified server-side against
the project's public keys (ES256/RS256, with legacy HS256 supported).

**Investment Guidance** and **My Investments** are not public features. They are
gated server-side and return `404` — not `403` — to anyone without access, so
their existence is never advertised. Access has two tiers: **admins** (listed in
`GUIDANCE_OWNER_EMAILS`) and **members** (granted from inside the app by an
admin). If `GUIDANCE_OWNER_EMAILS` is empty while `NODE_ENV=production`, admin
routes deny everyone rather than admitting everyone.

---

## Working with fact-sheets

Automated fetching is the fragile part: insurers rotate URLs without notice and
some sit behind bot protection. Uploading the PDF by hand always works — sign in
as an admin, go to **Insurance → Manage data**, and drop the PDF on the drop
zone. The app shows you which insurer and month it detected, and its evidence,
before storing anything. An override that *contradicts* the document requires
explicit confirmation.

From the command line:

```bash
npm --prefix server run ulip              # fetch + extract all insurers
npm --prefix server run ulip:revalidate   # re-run validation over stored data
npm --prefix server run ulip:source-pages # map each fund to its page in the source PDF
```

You can also drop a PDF into the intake folder as `<insurer-id>_<YYYY-MM>.pdf`
(e.g. `hdfc_2026-05.pdf`) and re-run the pipeline.

| What you see | What happened |
|---|---|
| "That file isn't a PDF — it starts `<!DOCTY`…" | You saved a web page, not the document — this is what bot protection returns. |
| "Could not tell which insurer…" | No readable SFIN codes. Choose the insurer manually. |
| "…no funds could be parsed" | The PDF is stored and safe, but the layout changed. Update that insurer's extractor, then use **Re-extract stored**. |

---

## Scheduled jobs

All jobs respect `SCHEDULER_TZ` and are disabled by `SCHEDULER_ENABLED=false`.
They only reach the internet when `SCHEDULER_FETCH=1`.

| When | What |
|---|---|
| 18:30 daily | NSE end-of-day price ingest |
| 18:50 weekdays | Rule-based price alerts |
| 19:00 weekdays | Investment-guidance opportunity scan |
| 19:30 weekdays | Daily digest email (skipped without SMTP) |
| 06:30 daily | ULIP month-rollover check |
| 07:00 on the 3rd | Monthly ULIP fetch for the previous month |

---

## Development

```bash
npm run dev                          # frontend, hot reload (Vite :5174 → API :9787)
npm run build                        # typecheck + production build into server/dist
npm run lint

npm --prefix server run dev          # API with watch
npm --prefix server run typecheck
npm --prefix server test             # vitest
```

CI (`.github/workflows/ci.yml`) runs the frontend build and the server
typecheck + test suite on every push and pull request.

---

## Operations

The database is the only irreplaceable state — archived PDFs can be re-fetched
or re-uploaded.

```bash
# Backup
docker exec bharat_market_pro_pg pg_dump -U bharat_market_pro bharat_market_pro \
  | gzip > backup_$(date +%F).sql.gz

# Restore
gunzip -c backup.sql.gz \
  | docker exec -i bharat_market_pro_pg psql -U bharat_market_pro -d bharat_market_pro
```

`GET /api/health` returns `{"ok":true,"db":true}`, and 503 when the database is
unreachable — suitable for an uptime monitor. Logs: `docker compose logs -f app`.

---

## Troubleshooting

**Every panel is empty.** The database is empty — run
`npm --prefix server run ingest`.

**Login doesn't appear.** `VITE_SUPABASE_*` are baked in at build time; you need
`docker compose up -d --build`, not a restart.

**"Offline extractor unavailable" in the upload panel.** Python or PyMuPDF is
missing. In Docker, rebuild the image. Locally, `pip install pymupdf`.

**AI panels say not configured.** Expected without an API key — everything else
works, the AI features are additive.

**Port already in use.** Change `PORT` in `server/.env` and the published port
in `docker-compose.yml`.

---

## Project team

Built as a **minor project (Data Science)** at UPES by
**Anubhav Jain**, **Chirag Batra**, **Himanshu Kumar** and **Shikhar Singh**.

---

## Disclaimer

This is a research tool. It presents data, measured historical base rates and
their uncertainty — it does **not** constitute financial advice, and no output
should be read as a recommendation to buy or sell any security. You are
responsible for complying with the terms of the data sources you point it at,
and for any decisions you make with what it shows you.
