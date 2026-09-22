#!/usr/bin/env python3
"""Download bot-protected insurer factsheets into intake/ using a TLS-impersonating
client (curl_cffi) — no headless browser needed. These insurers (ICICI Prudential)
block plain HTTP at the CDN edge via TLS fingerprinting; impersonating Chrome's TLS
handshake gets through.

Usage:
    python scripts/fetch_protected.py [YYYY-MM]   # default: latest, names file by month

Then extract with the normal pipeline:
    cd server && npm run ulip -- icicipru 2026-05

Requires: pip install curl_cffi
"""
import sys
import os

try:
    from curl_cffi import requests
except ImportError:
    sys.exit("curl_cffi not installed — run: python -m pip install curl_cffi")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
INTAKE = os.path.join(ROOT, "intake")

# Bot-protected insurers and their stable "latest" factsheet URLs (TLS-impersonation
# reaches these). The site overwrites the same URL each month, so it's always current.
PROTECTED = {
    "icicipru": "https://www.iciciprulife.com/content/dam/icicipru/fund-performance/pdf/Fund_Performance_Details.pdf",
}


def main():
    month = sys.argv[1] if len(sys.argv) > 1 else "latest"
    os.makedirs(INTAKE, exist_ok=True)
    for adapter_id, url in PROTECTED.items():
        try:
            r = requests.get(url, impersonate="chrome", timeout=90)
            if r.status_code != 200 or not r.content.startswith(b"%PDF"):
                print(f"[fetch] {adapter_id}: HTTP {r.status_code}, not a PDF ({len(r.content)}b) — skipped")
                continue
            out = os.path.join(INTAKE, f"{adapter_id}_{month}.pdf")
            with open(out, "wb") as f:
                f.write(r.content)
            print(f"[fetch] {adapter_id}: saved {len(r.content)/1e6:.2f}MB -> intake/{adapter_id}_{month}.pdf")
        except Exception as e:  # noqa: BLE001
            print(f"[fetch] {adapter_id}: failed — {e}")


if __name__ == "__main__":
    main()
