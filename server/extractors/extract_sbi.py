#!/usr/bin/env python3
"""SBI Life ULIP newsletter -> ExtractionZ JSON (no Gemini).

One fund per page. Identity: "<NAME> (SFIN - ULIF...111) as on <date>". Page 612x792.
Sections (locked spec), each gated by its header:
  Assets Mix (In %)  : Equity/Debt/Money Market | Min | Max | Actual | AUM(In Crs)  (+ Total)
  Fund Details       : Fund Manager Name, Launch Date(inception), Benchmark, NAV, Modified Duration
  Fund Performance   : <Fund> row + Benchmark row over the printed periods
  ASSET CATEGORY     : categorized holdings (Equity / Corporate Debt / Money Market / Govt..),
                       ranked name + "% of AUM"  (incl. Others, skip Total/Grand Total)
  Top 10 Industry    : sector exposure (wrapped NIC names + %)
AUM in crore.  Usage: python extract_sbi.py <pdf>
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}
PCT=re.compile(r"^-?[\d,]+(?:\.\d+)?%?$")

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
        for d,mo,yr in re.findall(r"as on\s+(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})",pg.get_text(),re.I):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if c:
        (yr,mo),_=c.most_common(1)[0]; return f"{yr}-{mo:02d}"
    return None

def parse_launch(text):
    m=re.search(r"Launch\s*Date\s*([0-9]{1,2})-([A-Za-z]{3})-([0-9]{2,4})",text)
    if not m: return None
    d,mo,y=m.groups(); y=int(y); y=2000+y if y<100 else y
    return f"{y}-{ABBR.get(mo.lower(),1):02d}-{int(d):02d}" if mo.lower() in ABBR else None

def period_of(tokens):
    """['1','Mth'] -> '1M', ['6','Mths'] -> '6M', ['1','yr'] -> '1Y', ['Inception'] -> 'Inception'."""
    s=" ".join(tokens).lower()
    if "inception" in s: return "Inception"
    m=re.match(r"(\d+)\s*(mth|mths|month|yr|yrs|year|years)",s)
    if m:
        n=m.group(1); return f"{n}M" if m.group(2).startswith(("mth","month")) else f"{n}Y"
    return None

def parse_page(pg):
    text=pg.get_text()
    sm=re.search(r"SFIN\s*[–\-]\s*(UL[IGP]F[0-9A-Za-z/\-]+?\d{3})\)", text.replace("\n"," "))
    if not sm:
        sm=re.search(r"(UL[IGP]F[0-9A-Za-z/\-]{8,}\d{3})", text)
        if not sm: return None
    sfin=sm.group(1).strip()
    rws=rows(pg.get_text("words"))

    # name: the words before "(SFIN" on the identity row
    name=sfin
    for y,g in rws:
        idx=next((k for k,w in enumerate(g) if w[4].startswith("(SFIN")),None)
        if idx is not None:
            pre=[w[4] for w in g[:idx]]
            if pre: name=re.sub(r"\s+"," "," ".join(pre)).strip()
            break

    bm=re.search(r"Benchmark\s+(.+?)(?:\n|Risk|$)",text)
    benchmark=re.sub(r"\s+"," ",bm.group(1)).strip()[:60] if bm else None
    # NAV / MD / Launch Date: value sits in the right column (x>450) on the label's row
    nav=md=None; inception=None
    DATEW=re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{2,4}$")
    for y,g in rws:
        ws=[w[4] for w in g]
        if "NAV" in ws and ("as" in ws or "on" in ws):
            v=[num(w[4]) for w in g if w[0]>450 and re.match(r"^[\d,]+\.\d+$",w[4])]
            if v and nav is None: nav=v[0]
        if "Modified" in ws and "Duration" in ws:
            v=[num(w[4]) for w in g if w[0]>450 and re.match(r"^[\d.]+$",w[4])]
            if v and md is None: md=v[0]
        if "Launch" in ws and "Date" in ws:
            dv=next((w[4] for w in g if w[0]>450 and DATEW.match(w[4])),None)
            if dv: inception=parse_launch("Launch Date "+dv)
    mgrs=re.findall(r"(Mr\.?|Ms\.?|Mrs\.?)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})",text)
    manager=", ".join(dict.fromkeys(f"{a} {b}".strip() for a,b in mgrs)) or None

    # ---- section header y-anchors ----
    def yof(pred):
        for y,g in rws:
            if pred(" ".join(w[4] for w in g)): return y
        return None
    y_mix=yof(lambda t:"Assets Mix" in t)
    y_perf=yof(lambda t:"FUND PERFORMANCE" in t or "Returns" in t.split("\n")[0])
    y_cat=yof(lambda t:"ASSET CATEGORY" in t)
    y_perf=y_perf or 177; y_cat=y_cat or 231; y_mix=y_mix or 113

    # ================= ASSETS MIX (Min|Max|Actual|AUM) + AUM split =================
    alloc=[]; aum={"equity":None,"debt":None,"mmi":None,"total":None}
    for y,g in rws:
        if not (y_mix<=y<y_perf): continue
        lab=" ".join(w[4] for w in g if w[0]<120 and not PCT.match(w[4])).strip().lower()
        nums=[(w[0],num(w[4])) for w in g if 130<w[0]<330 and PCT.match(w[4])]
        nums.sort()
        if lab.startswith("equity"): key="equity"
        elif lab.startswith("debt"): key="debt"
        elif lab.startswith("money"): key="mmi"
        elif lab.startswith("total"): key="total"
        else: continue
        if key=="total":
            if nums: aum["total"]=nums[-1][1]
            continue
        # nums = [min, max, actual, aum]
        if len(nums)>=3:
            label={"equity":"Equity","debt":"Debt","mmi":"Money Market"}[key]
            alloc.append({"kind":"asset","label":label,"weight":nums[2][1],
                          "fuMin":nums[0][1],"fuMax":nums[1][1]})
        if len(nums)>=4: aum[key]=nums[3][1]

    # ================= RETURNS =================
    returns=[]
    # period header row (between perf header and the Fund row): has Mth/Inception
    perpos=[]
    for y,g in rws:
        if not (y_perf<=y<y_cat): continue
        toks=[w[4] for w in g if 120<w[0]<345]
        if any(re.match(r"(Mth|Mths|yr|yrs|Inception)",t,re.I) for t in toks):
            # build (x,period) by pairing a number with its unit / lone Inception
            buf=[]
            for w in g:
                if w[0]<120 or w[0]>345: continue
                if re.match(r"^\d+$",w[4]): buf=[(w[0],w[4])]
                elif re.match(r"(Mth|Mths|yr|yrs|month|year)",w[4],re.I) and buf:
                    p=period_of([buf[0][1],w[4]]); perpos.append((buf[0][0],p)); buf=[]
                elif "Inception" in w[4]: perpos.append((w[0],"Inception")); buf=[]
            if perpos: break
    valrows=[]
    for y,g in rws:
        if not (y_perf<=y<y_cat): continue
        vals=[(w[0],num(w[4])) for w in g if 120<w[0]<345 and re.match(r"^-?[\d.]+%$",w[4])]
        if len(vals)>=3: valrows.append(vals)
    if perpos and valrows:
        fund=valrows[0]; bench=valrows[1] if len(valrows)>1 else None
        for px,per in perpos:
            if not per: continue
            fv=min(fund,key=lambda v:abs(v[0]-px)); fr=fv[1] if abs(fv[0]-px)<22 else None
            br=None
            if bench:
                bv=min(bench,key=lambda v:abs(v[0]-px))
                br=bv[1] if abs(bv[0]-px)<22 else None
            returns.append({"period":per,"returnPct":fr,"benchmarkPct":br})

    # ================= HOLDINGS (ASSET CATEGORY, left col) =================
    holdings=[]; curcat=None
    def cat_of(t):
        s=t.lower().strip()
        if re.search(r"\d",s) or len(s)>30: return None
        if s.startswith("equit"): return "Equity"
        if "money market" in s or s=="cash": return "Money Market"
        if "government" in s and "securit" in s: return "Government Securities"
        if s.startswith("corporate") or s in ("debt","bonds","debentures","fixed deposit"): return "Corporate Debt"
        return None
    for y,g in rws:
        if y<y_cat: continue
        line=" ".join(w[4] for w in g)
        nmw=[w for w in g if 15<w[0]<290 and not re.match(r"^\d{1,2}$",w[4])]
        pct=[w for w in g if 290<w[0]<330 and re.match(r"^-?[\d.]+%$",w[4])]
        if not nmw: continue
        nm=re.sub(r"\s+"," "," ".join(w[4] for w in nmw)).strip()
        low=nm.lower()
        c=cat_of(nm)
        if c and not pct: curcat=c; continue
        if not pct: continue
        if low in ("total","grand total") or "grand total" in low: continue
        holdings.append({"security":nm,"weightPct":num(pct[0][4]),"rawCategory":c or curcat or "Equity"})

    # ================= SECTOR (Top 10 Industry, right col) =================
    snames=[]; spcts=[]; in_s=False
    for y,g in rws:
        line=" ".join(w[4] for w in g)
        if "INDUSTRY" in line and ("SECTOR" in line or "TOP" in line): in_s=True; continue
        if not in_s: continue
        for w in g:
            if 350<w[0]<505 and not re.match(r"^-?[\d.]+%?$",w[4]):
                snames.append((y,w[0],w[4]))
            elif w[0]>=505 and re.match(r"^-?[\d.]+%$",w[4]):
                spcts.append((y,num(w[4])))
    for py,pv in spcts:
        block=[(wy,wx,t) for wy,wx,t in snames if abs(wy-py)<=11]
        lab=re.sub(r"\s+"," "," ".join(t for _,_,t in sorted(block,key=lambda z:(z[0],z[1])))).strip()
        lab=re.sub(r"^(TOP 10|INDUSTRY|SECTOR)\s*","",lab,flags=re.I).strip()
        if lab and len(lab)>2: alloc.append({"kind":"sector","label":lab,"weight":pv})

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
            "ytm":None,"modifiedDuration":md,"managedSummary":None,
            "aum":aum,"returns":returns,"allocations":alloc,"holdings":holdings}

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
