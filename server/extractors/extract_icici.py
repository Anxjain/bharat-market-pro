#!/usr/bin/env python3
"""ICICI Prudential Life ULIP -> ExtractionZ JSON (no Gemini).

ICICI publishes fund data via a JSON web API (browser-only; plain curl gets a 403
from their Akamai WAF). The raw arrays were captured through a real browser
(Playwright) and saved under out/ so this transform is reproducible offline:

  out/icici_funds_api.json    list of ~153 funds  (funds-all-products.htm)
                              -> AssetClass, LAfundCode, Fund, SFIN, NAVLatest,
                                 InceptionDate, Perf1Month..Perf10Year, PerfInception
  out/icici_perf_api.json     {fundCode: {fundSummary[], fundcomposition[], ...}}
                              (funds-product-performance.htm per fund)
                              -> fundSummary[0] perf+assetsInvested(total AUM, in RUPEES),
                                 fundSummary[1] = benchmark return row,
                                 fundcomposition[] asset mix: assetmix label (verbatim),
                                 limits ("Minimum X% and Maximum Y%"), composition (actual %),
                                 AUM (per-asset, in RUPEES)
  out/icici_headers_api.json  {fundCode: [ {managerName, NAVPrevMonth, benchmark,
                                 noOfFunds, ...}, ... ]}  (fundHeaderData.htm per fund)

HOLDINGS: ICICI's web portal does NOT expose per-security holdings, and the only
IRDAI factsheet PDF they publish (factsheets/ICICI-...performance...pdf) is a pure
fund-performance table (returns + benchmark, zero ISIN/holdings). Holdings are
therefore genuinely unavailable -> [] for every fund (loader marks holdings absent).

AUM in Crore (assetsInvested / 1e7).  NAV = NAVPrevMonth (month-end NAV for the
snapshot month), falling back to NAVLatest.

Usage: PYTHONIOENCODING=utf-8 python extract_icici.py [YYYY-MM] > out/icici_2026-05.json
"""
import sys, os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# returns periods available on the funds-all-products array
PERIODS = [("1M", "Perf1Month"), ("6M", "Perf6Month"), ("1Y", "Perf1Year"),
           ("2Y", "Perf2Year"), ("3Y", "Perf3Year"), ("4Y", "Perf4Year"),
           ("5Y", "Perf5Year"), ("7Y", "Perf7Year"), ("10Y", "Perf10Year"),
           ("Inception", "PerfInception")]
# benchmark return row (fundSummary[1]) only carries these periods
BM_PERIODS = {"1M": "Perf1Month", "6M": "Perf6Month", "1Y": "Perf1Year",
              "2Y": "Perf2Year", "3Y": "Perf3Year", "4Y": "Perf4Year",
              "5Y": "Perf5Year", "Inception": "PerfInception"}


def load(name):
    d = json.loads(open(os.path.join(OUT, name), encoding="utf-8").read())
    return json.loads(d) if isinstance(d, str) else d


def num(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "").replace("%", "")
    if s == "" or s.upper() in ("NA", "N.A.", "N.A", "-", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def pct(s):
    """Parse a return cell '8.51%' -> 8.51 ; 'NA' -> None."""
    if s is None:
        return None
    if str(s).strip().upper() in ("NA", "N.A.", "N.A", "", "-"):
        return None
    return num(s)


def parse_limits(s):
    """'Minimum 30% and Maximum 70%' / 'Maximum 100% and Minimum 0%' / 'Minimum 80%'
       -> (fuMin, fuMax)."""
    if not s:
        return None, None
    mn = re.search(r"Minimum\s*(-?\d+(?:\.\d+)?)\s*%", s, re.I)
    mx = re.search(r"Maximum\s*(-?\d+(?:\.\d+)?)\s*%", s, re.I)
    return (float(mn.group(1)) if mn else None,
            float(mx.group(1)) if mx else None)


def aum_bucket(label):
    """Map a verbatim asset-mix label to an aum split key (best effort)."""
    l = label.lower()
    if "equity" in l:
        return "equity"
    if "debt" in l or "government" in l:
        return "debt"        # combined 'Debt, Money Market and Cash' -> debt bucket
    if "money market" in l or "cash" in l:
        return "mmi"
    return None


def build():
    funds = load("icici_funds_api.json")
    perf = load("icici_perf_api.json")
    headers = load("icici_headers_api.json")

    out = []
    for f in funds:
        code = f.get("LAfundCode")
        sfin = (f.get("SFIN") or "").strip()
        if not sfin:
            continue
        name = (f.get("Fund") or "").strip()
        pv = perf.get(code) or {}
        fsum = pv.get("fundSummary") or []
        fund_row = fsum[0] if fsum else {}
        bm_row = fsum[1] if len(fsum) > 1 and (fsum[1].get("Fund") == "Benchmark Return") else None
        hdr = headers.get(code)
        hdr = hdr if isinstance(hdr, list) else []

        # ---- nav (month-end), inception ----
        navprev = next((h.get("NAVPrevMonth") for h in hdr if h.get("NAVPrevMonth")), None)
        nav = num(navprev) if navprev else num(f.get("NAVLatest"))
        inception = (f.get("InceptionDate") or fund_row.get("InceptionDate") or None)
        if inception:
            inception = inception.strip() or None

        # ---- benchmark + manager ----
        benchmark = next((h.get("benchmark") for h in hdr if h.get("benchmark")), None)
        if not benchmark and bm_row:
            benchmark = bm_row.get("SFIN")
        if benchmark:
            benchmark = benchmark.strip()
            if benchmark.lower() in ("no benchmark", "na"):
                benchmark = None
        managers = []
        for h in hdr:
            m = (h.get("managerName") or "").strip()
            if m and m not in managers:
                managers.append(m)
        manager = ", ".join(managers) or None

        # ---- AUM (Cr) ----
        total = num(fund_row.get("assetsInvested"))
        aum = {"equity": None, "debt": None, "mmi": None,
               "total": round(total / 1e7, 2) if total is not None else None}
        comp = pv.get("fundcomposition") or []
        for a in comp:
            key = aum_bucket(a.get("assetmix") or "")
            av = num(a.get("AUM"))
            if key and av is not None:
                cr = round(av / 1e7, 2)
                aum[key] = round((aum[key] or 0) + cr, 2)

        # ---- returns (fund from all-products row; benchmark from perf row) ----
        returns = []
        for per, fk in PERIODS:
            rp = pct(f.get(fk))
            bp = pct(bm_row.get(BM_PERIODS[per])) if (bm_row and per in BM_PERIODS) else None
            if rp is None and bp is None:
                continue
            returns.append({"period": per, "returnPct": rp, "benchmarkPct": bp})

        # ---- allocations: asset mix (verbatim label, actual + F&U min/max) ----
        allocations = []
        for a in comp:
            label = (a.get("assetmix") or "").strip()
            if not label:
                continue
            w = num(a.get("composition"))
            fu_min, fu_max = parse_limits(a.get("limits"))
            allocations.append({"kind": "asset", "label": label, "weight": w,
                                "fuMin": fu_min, "fuMax": fu_max})

        cls = "Group" if sfin.upper().replace(" ", "").startswith("ULGF") else "Individual"

        out.append({
            "sfin": sfin, "name": name, "class": cls, "category": None,
            "nav": nav, "inception": inception, "benchmark": benchmark,
            "manager": manager,
            "ytm": None, "modifiedDuration": None, "managedSummary": None,
            "aum": aum,
            "returns": returns,
            "allocations": allocations,
            "holdings": [],  # ICICI web portal exposes no per-security holdings
        })
    return out


def main():
    month = sys.argv[1] if len(sys.argv) > 1 else "2026-05"
    funds = build()
    print(json.dumps({"month": month, "funds": funds}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
