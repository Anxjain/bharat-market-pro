#!/usr/bin/env python3
"""Bharti AXA Life factsheet -> ExtractionZ JSON (no Gemini).

One fund per page (detect by the SFIN/ULIF token). Page 612x792. Equity and
debt/liquid pages share the SAME section structure but shift their column x's
(right column starts ~x333 on debt pages vs ~x364 on equity), so every detector
is gated by its section HEADER and uses generous x-bands, not fixed positions.
Sections (locked spec): header, returns(Fund+Benchmark), Fund Details(NAV/MD/AUM
split, in Lakhs), Asset Allocation(F&U min-max + Actual), categorized holdings,
Industry/Sector exposure, manager + managed-summary.
Usage: python extract_bharti.py <pdf> [YYYY-MM]
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}
PCT=re.compile(r"^-?\d+(?:\.\d+)?$")
PERIODS=["1M","6M","1Y","2Y","3Y","5Y","Inception"]

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
        for mo,yr in re.findall(r"(?:as on|As on|AS ON)\s+(?:\d{1,2}\s+)?([A-Za-z]+)\s+(20\d{2})",pg.get_text()):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if c:
        (yr,mo),_=c.most_common(1)[0]; return f"{yr}-{mo:02d}"
    return None

def parse_page(pg):
    text=pg.get_text()
    sm=re.search(r"(UL[IGP]F[0-9A-Za-z/]{10,})", text)
    if not sm: return None
    sfin=sm.group(1).strip()
    rws=rows(pg.get_text("words"))

    # ---- name: first real text row (the title), skipping section headers ----
    name=None
    for y,g in rws:
        t=re.sub(r"\s+"," "," ".join(w[4] for w in g)).strip()
        if not t or "SFIN" in t or "Objective" in t: continue
        if re.match(r"^(1\s*Month|Fund Performance|Asset|Instrument|Security|Sector)",t,re.I): continue
        name=t; break
    name=name or sfin

    inception=None
    im=re.search(r"Inception\s*Date-?\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})",text)
    if im:
        dd,mo,yy=im.groups()
        if mo.lower() in ABBR: inception=f"{yy}-{ABBR[mo.lower()]:02d}-{int(dd):02d}"
    bm=re.search(r"Benchmark:\s*([^,*\n]+)",text)
    benchmark=bm.group(1).strip() if bm else None

    # ================= RETURNS: first two rows with >=7 numbers in x90-345 =================
    returns=[]
    numrows=[(y,[num(w[4]) for w in g if 90<w[0]<345 and PCT.match(w[4])]) for y,g in rws]
    numrows=[(y,n) for y,n in numrows if len(n)>=7]
    if numrows:
        fund=numrows[0][1][:7]; bench=numrows[1][1][:7] if len(numrows)>1 else None
        for i,p in enumerate(PERIODS):
            returns.append({"period":p,"returnPct":fund[i],
                            "benchmarkPct":bench[i] if bench and i<len(bench) else None})

    # ================= NAV / MD (labels scattered, values on the next row) =================
    nav=md=None
    for i,(y,g) in enumerate(rws):
        labs=[w[4] for w in g]
        if "NAV" in labs and i+1<len(rws):
            v=[num(w[4]) for w in rws[i+1][1] if w[0]<150 and PCT.match(w[4])]
            if v and nav is None: nav=v[0]
        if "Modified" in labs and "Duration" in labs and i+1<len(rws):
            v=[num(w[4]) for w in rws[i+1][1] if 250<w[0]<320 and PCT.match(w[4])]
            if v and md is None: md=v[0]

    # ====== RIGHT COLUMN: Asset-Class AUM (top) then Asset Allocation, gated by headers ======
    aum={"equity":None,"debt":None,"mmi":None,"total":None}; alloc=[]; region=None
    for y,g in rws:
        ws=[w[4] for w in g]; line=" ".join(ws)
        if "Asset" in ws and "AUM" in line and "Exposure" in line: region="aum"; continue
        if "Asset" in ws and "Allocation(%)" in line: region="alloc"; continue
        if "Sector" in ws and "Allocation" in ws: region=None
        lab=" ".join(w[4] for w in g if 320<w[0]<456 and not PCT.match(w[4])).strip().lower()
        if region=="aum":
            vals=sorted((w[0],num(w[4])) for w in g if w[0]>=456 and PCT.match(w[4]))
            key={"equity":"equity","debt":"debt","money market/cash":"mmi","total":"total"}.get(lab)
            if key and vals: aum[key]=vals[0][1]            # leftmost = AUM (rightmost = exposure %)
        elif region=="alloc":
            band=[num(w[4]) for w in g if 456<w[0]<515 and PCT.match(w[4])]
            act=[num(w[4]) for w in g if w[0]>=515 and PCT.match(w[4])]
            label={"equity":"Equity","debt":"Debt","money market/cash":"Money Market"}.get(lab)
            if label and act:
                alloc.append({"kind":"asset","label":label,"weight":act[0],
                              "fuMin":band[0] if band else None,"fuMax":band[1] if len(band)>1 else None})

    # ================= HOLDINGS (left col; pct just left of the right column) =================
    holdings=[]; curcat=None; in_h=False
    def cat_of(t):
        s=t.lower().strip()
        if re.search(r"\d", s) or len(s)>34: return None   # security names carry %/dates -> never a header
        if s.startswith("equit"): return "Equity"
        if "money market" in s or s=="cash": return "Money Market"
        if "government securities" in s or "govt securities" in s or s in ("g-sec","gsec"): return "Government Securities"
        if s in ("debt","bonds","debentures") or s.startswith("corporate"): return "Debt"
        return None
    for y,g in rws:
        ws=[w[4] for w in g]; line=" ".join(ws)
        if "Security" in ws and "Name" in ws: in_h=True; continue
        if not in_h: continue
        if "Name" in ws and "Manager" in line: break
        nmw=[w for w in g if w[0]<250 and not PCT.match(w[4])]
        pct=[w for w in g if 250<w[0]<348 and PCT.match(w[4])]
        if not nmw: continue
        nm=re.sub(r"\s+"," "," ".join(w[4] for w in nmw)).strip()
        low=nm.lower()
        c=cat_of(nm)
        if c in ("Equity","Debt","Government Securities"): curcat=c; continue
        if not pct: continue
        if low in ("total","grand total"): continue
        # the holding's % is the LEFTMOST number after the name; stray right-column
        # values (e.g. an F&U "40") can fall in-band and must not be picked.
        holdings.append({"security":nm,"weightPct":num(pct[0][4]),"rawCategory":c or curcat or "Equity"})

    # ================= SECTOR (right col; wrapped names -> nearest-% by y) =================
    snames=[]; spcts=[]; in_s=False
    for y,g in rws:
        ws=[w[4] for w in g]; line=" ".join(ws)
        if "Sector" in ws and "Allocation" in ws: in_s=True; continue
        if not in_s: continue
        if "Name" in ws and "Manager" in line or "Other Funds" in line: break
        if len([w for w in g if PCT.match(w[4])])>=5: continue       # the 0/5/10/.. axis row
        for w in g:
            if 320<w[0]<462 and not PCT.match(w[4]) and not w[4].lower().startswith(("%","to","fund")):
                snames.append((y,w[0],w[4]))
            elif w[0]>=462 and PCT.match(w[4]):
                spcts.append((y,num(w[4])))
    for py,pv in spcts:
        block=[(wy,wx,t) for wy,wx,t in snames if abs(wy-py)<=11]
        lab=re.sub(r"\s+"," "," ".join(t for _,_,t in sorted(block,key=lambda z:(z[0],z[1])))).strip().rstrip("…").strip()
        if lab and len(lab)>2: alloc.append({"kind":"sector","label":lab,"weight":pv})

    # ================= MANAGER =================
    manager=None; managed=None
    mm=re.search(r"Name of Fund Manager-?\s*([^\n]+)",text)
    if mm: manager=re.sub(r"\s+"," ",mm.group(1)).strip()
    om=re.search(r"Other Funds Managed By fund Manager:?\s*(.+?)(?:\n\n|$)",text,re.S)
    if om: managed=re.sub(r"\s+"," ",om.group(1)).strip()[:300]

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
            "ytm":None,"modifiedDuration":md,"managedSummary":managed,
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
