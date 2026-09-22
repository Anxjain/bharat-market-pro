#!/usr/bin/env bash
# Load a Bharat Market Pro DB snapshot into the VM's Postgres so the live site starts with
# all our local data (no empty database, no re-ingest needed).
#
# Run ON THE VM, AFTER `docker compose up -d` (Postgres must be healthy):
#   bash scripts/db-restore.sh                 # restores bharat_market_pro_db.dump
#   bash scripts/db-restore.sh my.dump
set -e
DUMP="${1:-bharat_market_pro_db.dump}"
CONTAINER="${PG_CONTAINER:-bharat_market_pro_pg}"

[ -f "$DUMP" ] || { echo "dump not found: $DUMP"; exit 1; }
echo "Waiting for Postgres to be ready…"
until docker exec "$CONTAINER" pg_isready -U bharat_market_pro -d bharat_market_pro >/dev/null 2>&1; do sleep 2; done

echo "Restoring $DUMP into $CONTAINER …"
docker exec -i "$CONTAINER" pg_restore -U bharat_market_pro -d bharat_market_pro --clean --if-exists --no-owner < "$DUMP"

echo "Done. Verifying counts:"
docker exec "$CONTAINER" psql -U bharat_market_pro -d bharat_market_pro -c \
  "SELECT (SELECT count(*) FROM funds) AS funds, (SELECT count(DISTINCT date) FROM prices) AS trading_days, (SELECT count(*) FROM fact_sheets) AS fact_sheets;"
