#!/usr/bin/env python3
"""Shriram Life factsheet -> ExtractionZ JSON (no Gemini).

One fund per page ("SFIN:ULIF...128"). Page 612x792, three columns:
  left   : INVESTMENT OBJECTIVE, FUND DETAILS (Type/Inception/NAV/AUM Crs/MD/YTM/FMC/
           Manager/Benchmark), PERFORMANCE METER (PERIOD | ACTUAL % | BENCHMARK %)
  middle : SECTOR ALLOCATION AS PER NIC-2008 (wrapped industry name | % to AUM)
  right  : TOP-10 HOLDINGS (ISSUER NAME | RATING | % to AUM), categorized + RATING PROFILE
Holdings carry a RATING column (debt) — captured. AUM in crore.
Usage: python extract_shriram.py <pdf>
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}

def rows(ws,tol=2.5):
    out=[]
    for w in sorted(ws,key=lambda w:(w[1],w[0])):
        if out and abs(w[1]-out[-1][0])<=tol: out[-1][1].append(w)
        else: out.append([w[1],[w]])
    return [(round(y),sorted(g,key=lambda x:x[0])) for y,g in out]

def num(s):
    try: return float(s.replace(",","").replace("%",""))
    except: return None

def detect_month(doc):
    c=Counter()
    for pg in doc:
        for d,mo,yr in re.findall(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(20\d{2})",pg.get_text()):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if c:
        (yr,mo),_=c.most_common(1)[0]; return f"{yr}-{mo:02d}"
    return None

def period_of(lab):
    s=lab.lower()
    if "inception" in s: return "Inception"
    m=re.match(r"(\d+)\s*(month|months|year|years)",s)
    if m: return f"{m.group(1)}M" if m.group(2).startswith("month") else f"{m.group(1)}Y"
    return None

def header_cat(s):
    """Map a holdings category header/subtotal line -> canonical category (or 'SKIP').
    Handles wrapped headers where only the tail word prints ("SECURITIES", "BONDS")."""
    u=re.sub(r"\s+"," ",s).upper().strip()
    if u in ("GRAND TOTAL","TOTAL"): return "SKIP"
    if u=="EQUITY": return "Equity"
    if "GOVERNMENT SECURITIES" in u or u in ("SECURITIES","GOVERNMENT"): return "Government Securities"
    if u in ("BONDS","CORPORATE BONDS","CORPORATE DEBT","DEBENTURES","CORPORATE","DEBT"): return "Corporate Debt"
    if "MMI" in u or ("CASH EQUIVALENT" in u and "NCA" not in u): return "Money Market"
    if u=="MUTUAL FUND": return "Mutual Fund"
    if u=="FIXED DEPOSIT": return "Fixed Deposit"
    return None

def parse_page(pg):
    text=pg.get_text()
    sm=re.search(r"SFIN:?\s*(UL[IGP]F[0-9A-Za-z/]+)", text.replace("\n"," "))
    if not sm: return None
    sfin=sm.group(1).strip()
    rws=rows(pg.get_text("words"))

    # ---- name: the FACTSHEET title row ----
    name=sfin
    for y,g in rws:
        t=" ".join(w[4] for w in g)
        if "FACTSHEET" in t:
            name=re.sub(r"\s*FACTSHEET\s*","",re.sub(r"\s+"," ",t)).strip() or sfin
            break

    # ================= FUND DETAILS (left col: label x<60, value x110-200) =================
    nav=md=ytm=aum=None; inception=None; manager=None; benchmark=None
    def detail(g):
        return " ".join(w[4] for w in g if w[0]>=108 and w[0]<260).strip()
    for y,g in rws:
        lab=" ".join(w[4] for w in g if w[0]<108).strip().lower()
        val=detail(g)
        if lab.startswith("month of inception"):
            m=re.match(r"([A-Za-z]{3})-(\d{2})",val)
            if m and m.group(1).lower() in ABBR: inception=f"20{m.group(2)}-{ABBR[m.group(1).lower()]:02d}"
        elif lab=="nav": nav=num(val)
        elif lab.startswith("aum"): aum=num(val)
        elif lab.startswith("modified duration"): md=num(val)
        elif lab=="ytm": ytm=num(val)
        elif lab.startswith("fund manager"): manager=val or None
        elif lab=="benchmark": benchmark=val or None

    # ================= RETURNS (PERFORMANCE METER) =================
    returns=[]; in_p=False
    for y,g in rws:
        line=" ".join(w[4] for w in g)
        if "PERFORMANCE" in line and "METER" in line: in_p=True; continue
        if not in_p: continue
        if "RATING" in line and "PROFILE" in line: continue
        lab=" ".join(w[4] for w in g if w[0]<110).strip()
        per=period_of(lab)
        if not per: continue
        vals=[num(w[4]) for w in g if 110<w[0]<200 and re.match(r"^-?[\d.]+%$",w[4])]
        if vals:
            returns.append({"period":per,"returnPct":vals[0],
                            "benchmarkPct":vals[1] if len(vals)>1 else None})

    # ================= HOLDINGS (right col: name | rating | %) =================
    holdings=[]; curcat=None; in_h=False
    for y,g in rws:
        line=" ".join(w[4] for w in g)
        if "TOP-10" in line and "HOLDINGS" in line: in_h=True
        if not in_h: continue
        if "RATING" in line and "PROFILE" in line: break
        nmw=[w for w in g if 445<w[0]<545 and not re.match(r"^-?[\d.]+%$",w[4])]
        rtw=[w for w in g if 545<w[0]<572 and not re.match(r"^-?[\d.]+%$",w[4])]
        pct=[w for w in g if w[0]>=572 and re.match(r"^-?[\d.]+%$",w[4])]
        if not nmw: continue
        nm=re.sub(r"\s+"," "," ".join(w[4] for w in nmw)).strip()
        up=nm.upper()
        if up in ("ISSUER NAME","RATING","% TO AUM","TOP-10 HOLDINGS","HOLDINGS"): continue
        hc=header_cat(nm)
        if hc:                          # category header / subtotal line
            if hc!="SKIP": curcat=hc
            continue
        if not pct: continue
        rating=re.sub(r"\s+"," "," ".join(w[4] for w in rtw)).strip() or None
        holdings.append({"security":nm,"weightPct":num(pct[0][4]),
                         "rawCategory":curcat or "Equity","rating":rating})

    # ================= SECTOR (middle col, wrapped) =================
    snames=[]; spcts=[]; in_s=False
    for y,g in rws:
        line=" ".join(w[4] for w in g)
        if "SECTOR" in line and "ALLOCATION" in line: in_s=True; continue
        if not in_s: continue
        if "TOP-10" in line or "FUND" in [w[4] for w in g] and "DETAILS" in line: pass
        for w in g:
            if 200<w[0]<400 and not re.match(r"^-?[\d.]+%?$",w[4]) and w[4] not in ("INDUSTRY","NAME"):
                snames.append((y,w[0],w[4]))
            elif 400<w[0]<445 and re.match(r"^-?[\d.]+%$",w[4]):
                spcts.append((y,num(w[4])))
    # build alloc list (sector + derived asset from holdings category subtotals)
    # Shriram sector names sit on the SAME row as their % (occasionally +1 wrap line),
    # so pair within a tight y-window to avoid pulling in the neighbouring sector.
    alloc=[]
    for py,pv in spcts:
        block=[(wy,wx,t) for wy,wx,t in snames if abs(wy-py)<=4]
        lab=re.sub(r"\s+"," "," ".join(t for _,_,t in sorted(block,key=lambda z:(z[0],z[1])))).strip()
        if lab and len(lab)>2 and not lab.upper().startswith("GRAND TOTAL"):
            alloc.append({"kind":"sector","label":lab,"weight":pv})

    # asset allocation: Shriram prints no Min/Max table -> derive Actual from category subtotals
    catsum={}
    for h in holdings:
        catsum[h["rawCategory"]]=catsum.get(h["rawCategory"],0)+ (h["weightPct"] or 0)
    for lab,wt in catsum.items():
        alloc.append({"kind":"asset","label":lab,"weight":round(wt,2),"fuMin":None,"fuMax":None})

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
            "ytm":ytm,"modifiedDuration":md,"managedSummary":None,
            "aum":{"equity":None,"debt":None,"mmi":None,"total":aum},
            "returns":returns,"allocations":alloc,"holdings":holdings}

def main():
    doc=fitz.open(sys.argv[1])
    month=detect_month(doc) or (sys.argv[2] if len(sys.argv)>2 else None)
    funds=[]; seen=set()
    for pg in doc:
        f=parse_page(pg)
        if f and f["sfin"] not in seen:
            seen.add(f["sfin"]); funds.append(f)
    print(json.dumps({"month":month,"funds":funds}, indent=2, ensure_ascii=False))

if __name__=="__main__":
    main()
