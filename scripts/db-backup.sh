#!/usr/bin/env bash
# Snapshot THIS machine's Bharat Market Pro database to a single file you can carry to the VM.
# Captures everything: funds, holdings, returns, allocations, 90+ days of prices,
# fact-sheets, desk notes, watchlists. Run on the machine where the DB container runs.
#
#   bash scripts/db-backup.sh            # -> bharat_market_pro_db.dump
#   bash scripts/db-backup.sh my.dump
set -e
OUT="${1:-bharat_market_pro_db.dump}"
CONTAINER="${PG_CONTAINER:-bharat_market_pro_pg}"
docker exec "$CONTAINER" pg_dump -U bharat_market_pro -Fc bharat_market_pro > "$OUT"
echo "Backed up -> $OUT ($(du -h "$OUT" | cut -f1))"
echo "Copy it to the VM, e.g.:  scp $OUT root@YOUR_VM_IP:/opt/bharat-market-pro/"
