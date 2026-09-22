#!/usr/bin/env bash
# Load the bundled starter dataset into a fresh Bharat Market Pro install.
#
#   bash scripts/restore-data.sh
#
# What it loads (from ./data/):
#   • bharat_market_pro_data.sql.gz — the full research database: NSE prices, corporate
#     filings, news, ULIP fund data with holdings, computed guidance labels and
#     snapshots. No accounts, portfolios or personal data of any kind.
#   • raw_archive.tar.gz    — the original insurer fact-sheet PDFs these were
#     parsed from, so every fund's "source document" link resolves and any month
#     can be re-parsed offline.
#
# Safe to re-run: it refuses to overwrite a database that already holds data
# unless you pass --force.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="${DATA_DIR:-./data}"
DUMP="$DATA_DIR/bharat_market_pro_data.sql.gz"
ARCHIVE="$DATA_DIR/raw_archive.tar.gz"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Prefer the compose container; fall back to a local psql when running outside Docker.
PG_CONTAINER="${PG_CONTAINER:-bharat_market_pro_pg}"
PG_USER="${PG_USER:-bharat_market_pro}"
PG_DB="${PG_DB:-bharat_market_pro}"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
  PSQL=(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB")
  MODE="docker container $PG_CONTAINER"
elif command -v psql >/dev/null 2>&1; then
  : "${DATABASE_URL:?Set DATABASE_URL, or start the compose stack first}"
  PSQL=(psql "$DATABASE_URL")
  MODE="DATABASE_URL"
else
  echo "❌ Need either the compose Postgres container running, or psql on PATH."
  exit 2
fi

[ -f "$DUMP" ] || { echo "❌ $DUMP not found."; exit 2; }

echo "→ target: $MODE"

# Don't silently clobber an instance that is already in use.
existing="$("${PSQL[@]}" -t -A -c "select coalesce((select count(*) from prices),0)" 2>/dev/null || echo 0)"
if [ "${existing:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
  echo "⚠️  This database already has $existing price rows."
  echo "    Re-run with --force to replace its contents with the bundled dataset."
  exit 1
fi

echo "→ loading database (~73 MB compressed; a few minutes)…"
# The dump carries its own CREATE TABLE / COPY statements. Existing-object notices
# are expected when the app has already booted once and run its migrations.
gunzip -c "$DUMP" | "${PSQL[@]}" -q 2>&1 \
  | grep -viE 'already exists|^NOTICE|^SET|^\s*$|^\s*setval|^\s*set_config|^-+$|^\(1 row\)$' || true

rows="$("${PSQL[@]}" -t -A -c 'select count(*) from prices' 2>/dev/null || echo 0)"
funds="$("${PSQL[@]}" -t -A -c 'select count(*) from funds' 2>/dev/null || echo 0)"
echo "✓ database loaded — $rows price rows, $funds ULIP fund rows"

if [ -f "$ARCHIVE" ]; then
  # RAW_DIR defaults to ./raw locally; in Docker it is the /data/raw volume.
  target="${RAW_DIR:-./raw}"
  echo "→ unpacking source fact-sheet PDFs into $target …"
  mkdir -p "$(dirname "$target")"
  # The tarball contains a top-level raw/ directory.
  tar xzf "$ARCHIVE" -C "$(dirname "$target")"
  echo "✓ $(find "$target" -name '*.pdf' 2>/dev/null | wc -l) PDFs unpacked"
else
  echo "· no raw_archive.tar.gz found — skipping PDFs (fund data still works;"
  echo "  only the 'view source document' links need them)"
fi

echo
echo "Done. Start the app and you should see a fully populated instance."
echo "To keep it current: npm --prefix server run ingest   (daily prices)"
