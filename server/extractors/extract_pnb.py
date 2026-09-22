#!/usr/bin/env python3
"""PNB MetLife fund factsheet -> ExtractionZ JSON (no Gemini).

One fund per page (detect by "SFIN No:"). Page is 845x1375, two columns.
Sections captured per the locked spec (matches the printed factsheet 1:1):
  Header        : name (top row), SFIN, as-on date -> month
  Fund Details  : Inception | NAV | YTM | MD | AUM  + Fund Manager(s) + managed-summary
  Returns       : "Fund v/s Benchmark Return (%)" — period | fund% | benchmark%
  Asset alloc   : "Actual v/s Targeted Asset Allocation" — type | Min | Max | Actual
  Holdings      : "Security Name / Net Asset (%)" — categorized (Equity/Debt/Cash..),
                  every printed name + %, incl. "Others" and "Cash and Money Market"
  Industry      : "Industry Wise Exposure" — NIC activity | % (incl. Others)
AUM printed in crore.  Usage: python extract_pnb.py <pdf>
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}
PCT=re.compile(r"^-?\d+(?:\.\d+)?%$")
DATEW=re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{4}$")
PERIODS={"1 month":"1M","6 months":"6M","1 year":"1Y","2 years":"2Y","3 years":"3Y",
         "4 years":"4Y","5 years":"5Y","7 years":"7Y","10 years":"10Y","inception":"Inception"}

def rows(ws,tol=3.0):
    out=[]
    for w in sorted(ws,key=lambda w:(w[1],w[0])):
        if out and abs(w[1]-out[-1][0])<=tol: out[-1][1].append(w)
        else: out.append([w[1],[w]])
    return [(round(y),sorted(g,key=lambda x:x[0])) for y,g in out]

def num(s):
    try: return float(s.replace(",","").replace("%","").replace("Rs.","").strip())
    except: return None

def fix_spacing(s):
    """'H D F C BANK LTD.' -> 'HDFC BANK LTD.'; 'N T P C LTD.' -> 'NTPC LTD.'"""
    s=re.sub(r"\s+"," ",s).strip()
    # collapse a run of single-letter tokens (keeps the separator before the next real word)
    s=re.sub(r"\b(?:[A-Za-z&] )+[A-Za-z&]\b", lambda m:m.group(0).replace(" ",""), s)
    return re.sub(r"\s+"," ",s).strip()

def detect_month(doc):
    c=Counter()
    pat=re.compile(r"\b([A-Za-z]+)\s+\d{1,2},\s*(20\d{2})")
    for pg in doc:
        for mo,yr in pat.findall(pg.get_text()):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if not c: return None
    (yr,mo),_=c.most_common(1)[0]
    return f"{yr}-{mo:02d}"

def parse_inception(tok):
    m=re.match(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})",tok)
    if not m: return None
    d,mo,y=m.groups()
    return f"{y}-{ABBR.get(mo.lower(),1):02d}-{int(d):02d}" if mo.lower() in ABBR else None

def parse_page(pg):
    text=pg.get_text()
    sm=re.search(r"SFIN\s*No:?\s*(UL[IGP]F[0-9A-Za-z/]+)", text.replace("\n"," "))
    if not sm: return None
    sfin=sm.group(1).strip()
    rws=rows(pg.get_text("words"))

    # ---- header name: top row (y<55) with words at x>95, not the SFIN line ----
    name=None
    for y,g in rws:
        t=" ".join(w[4] for w in g if w[0]>95).strip()
        if t and "SFIN" not in t and y<55:
            name=re.sub(r"\s+"," ",t); break
    name=name or sfin

    # ================= FUND DETAILS (right column) =================
    nav=ytm=md=aum=None; inception=None; manager=None; managed=None
    for i,(y,g) in enumerate(rws):
        labs={w[4]:w[0] for w in g}
        if "Inception" in labs and "NAV" in labs and "AUM" in labs:
            lx={"nav":labs["NAV"],"ytm":labs.get("YTM",601),"md":labs.get("MD",655),"aum":labs["AUM"]}
            # value row sits a couple rows below (left-column objective text wraps between);
            # pick the next right-column row carrying the inception date / "Rs." values.
            for vy,vg in [r for r in rws[i+1:i+5]]:
                rc=[w for w in vg if w[0]>400]
                if not (any(DATEW.match(w[4]) for w in rc) or any(w[4]=="Rs." for w in rc)): continue
                for w in rc:
                    x=w[0]
                    if DATEW.match(w[4]): inception=parse_inception(w[4])
                    elif re.match(r"^-?\d[\d,]*(?:\.\d+)?%?$",w[4]):
                        v=num(w[4])
                        if abs(x-lx["nav"])<45: nav=nav or v
                        elif abs(x-lx["ytm"])<30: ytm=v
                        elif abs(x-lx["md"])<30: md=v
                        elif abs(x-lx["aum"])<70: aum=aum or v
                break
            break
    for i,(y,g) in enumerate(rws):
        if "Manager(s)" in " ".join(w[4] for w in g):
            for vy,vg in [r for r in rws[i+1:i+5]]:
                mgr=[w[4] for w in vg if 410<w[0]<560]
                summ=[w[4] for w in vg if w[0]>=575]
                if mgr or summ:
                    if mgr: manager=fix_spacing(" ".join(mgr))
                    if summ: managed=re.sub(r"\s+"," "," ".join(summ)).strip()
                    break
            break

    # ================= RETURNS (left column) =================
    returns=[]
    for y,g in rws:
        lab=" ".join(w[4] for w in g if w[0]<160).strip().lower()
        per=PERIODS.get(lab)
        if not per: continue
        ps=[(w[0],num(w[4])) for w in g if 230<w[0]<420 and PCT.match(w[4])]
        ps.sort()
        if ps:
            returns.append({"period":per,"returnPct":ps[0][1],
                            "benchmarkPct":ps[1][1] if len(ps)>1 else None})

    # ================= ASSET ALLOCATION (left column) =================
    alloc=[]; in_asset=False
    for y,g in rws:
        line=" ".join(w[4] for w in g if w[0]<420)
        if "Targeted Asset Allocation" in line: in_asset=True; continue
        if in_asset:
            if "actual asset allocation will remain" in line.lower(): in_asset=False; continue
            lab=" ".join(w[4] for w in g if w[0]<200 and not PCT.match(w[4])).strip()
            pcts=[(w[0],num(w[4])) for w in g if 200<w[0]<420 and PCT.match(w[4])]
            pcts.sort()
            low=lab.lower()
            if low in ("security type","") or low.startswith("the actual"): continue
            if lab and len(pcts)>=3:
                label={"equities":"Equity","equity":"Equity","debt":"Debt","money market":"Money Market"}.get(low,lab)
                alloc.append({"kind":"asset","label":label,"weight":pcts[-1][1],
                              "fuMin":pcts[0][1],"fuMax":pcts[1][1]})

    # ================= HOLDINGS (right column) =================
    holdings=[]; curcat=None; in_hold=False
    def cat_of(t):
        s=t.lower().strip()
        if s=="equity": return "Equity"
        if s in ("debt","corporate debt","bonds","debentures"): return "Debt"
        if s in ("government securities","govt securities","g-sec","gsec","sovereign"): return "Government Securities"
        if "cash and money market" in s or s in ("money market","mmi"): return "Cash and Money Market"
        return None
    for y,g in rws:
        nmw=[w for w in g if 440<w[0]<730 and not PCT.match(w[4])]
        pct=[w for w in g if w[0]>=730 and PCT.match(w[4])]
        line=" ".join(w[4] for w in g if w[0]>=440).strip()
        if "Security Name" in line and "Net Asset" in line: in_hold=True; continue
        if not in_hold: continue
        if not nmw: continue
        nm=fix_spacing(" ".join(w[4] for w in nmw))
        low=nm.lower()
        c=cat_of(nm)
        if c and not pct:                      # pure section header
            curcat=c; continue
        if not pct: continue
        if low in ("total","portfolio total","grand total"): continue
        cat=c or curcat or "Equity"
        holdings.append({"security":nm,"weightPct":num(pct[-1][4]),"rawCategory":cat})

    # ================= INDUSTRY-WISE EXPOSURE (left column, sector) =================
    in_ind=False
    for y,g in rws:
        line=" ".join(w[4] for w in g if w[0]<420)
        if "Industry Wise Exposure" in line: in_ind=True; continue
        if in_ind:
            if "Industry Classification" in line: break
            nmw=[w for w in g if 55<w[0]<215 and not PCT.match(w[4])]
            pcts=[w for w in g if w[0]>=215 and PCT.match(w[4])]
            if len(pcts)>=4: continue          # axis row (0.0 8.8 17.5 26.3 35.0)
            if not nmw or not pcts: continue
            lab=re.sub(r"\s+"," "," ".join(w[4] for w in nmw)).strip()
            if len(lab)<3: continue
            alloc.append({"kind":"sector","label":lab,"weight":num(pcts[-1][4])})

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":None,"manager":manager,
            "ytm":ytm,"modifiedDuration":md,"managedSummary":managed,
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
