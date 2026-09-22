#!/usr/bin/env python3
"""Bandhan Life "InDepth" factsheet -> ExtractionZ JSON (no Gemini).

Each fund spans consecutive pages: a HOLDINGS page (identity "<NAME> SFIN: ULIF...138",
Fund Manager(s), NAV, AUM, the COMPLETE two-column holdings list — no "Others"
truncation — then two-column Industry exposure) followed by a COMPANION page
(ASSET ALLOCATION "F&U | ACTUAL" for Equities/Fixed Income/Money Market, and a
"Period | Returns | Fund | Benchmark" table incl. "since inception (DD-Mon-YY)").
We attach each companion page to the most recent fund. Page 595x842, AUM in Cr.
Usage: python extract_bandhan.py <pdf> [YYYY-MM]
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
        for mo,yr in re.findall(r"\b([A-Za-z]+)\s+(20\d{2})\b",pg.get_text()):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if c:
        (yr,mo),_=c.most_common(1)[0]; return f"{yr}-{mo:02d}"
    return None

def fnum(t): return bool(re.match(r"^-?[\d.]+%?$",t))
def pctw(t): return bool(re.match(r"^-?[\d.]+%$",t))

def parse_holdings_page(pg):
    """Return a fund dict if this page is a fund HOLDINGS page, else None."""
    text=pg.get_text()
    sm=re.search(r"SFIN:?\s*(UL[IGP]F[0-9A-Za-z/]+)", text.replace("\n"," "))
    if not sm: return None
    if "HOLDINGS" not in text.upper(): return None
    sfin=sm.group(1).strip()
    rws=rows(pg.get_text("words"))

    # name: top title row (above SFIN), excluding the SFIN/Manager/Objective lines
    name=sfin
    for y,g in rws:
        t=re.sub(r"\s+"," "," ".join(w[4] for w in g)).strip()
        if not t or "SFIN" in t or "Fund Manager" in t or "Objective" in t: continue
        if y<60: name=t; break

    nav=None; aum=None; manager=[]
    nv=re.search(r"NAV\s*:?\s*([\d,]+\.\d+)",text)
    if nv: nav=num(nv.group(1))
    am=re.search(r"AUM\s*:?\s*([\d,]+\.\d+)",text)
    if am: aum=num(am.group(1))
    for m in re.findall(r"Fund Manager\s*:?\s*([A-Z][a-zA-Z ]+?)(?:\n|Investment|Fund Manager|$)",text):
        nm=re.sub(r"\s+"," ",m).strip()
        if nm and nm not in manager: manager.append(nm)

    # holdings: two side-by-side columns. Left: name x<240, % x240-270.
    # Right: name x300-525, % x525-555. Walk rows; a row may carry BOTH columns.
    holdings=[]; curcat={"L":"Equity","R":"Equity"}
    def cat_word(t):
        u=t.upper()
        if "EQUITY HOLDINGS" in u: return "Equity"
        if "DEBT" in u and "HOLDING" in u: return "Debt"
        if ("GOVERNMENT" in u or "GOVT" in u) and ("SEC" in u or "BOND" in u): return "Government Securities"
        if "MONEY MARKET" in u or "CASH" in u: return "Money Market"
        return None
    # NOTE: Bandhan holdings %s are PLAIN numbers (e.g. "8.93", no % sign).
    plainnum=lambda t: bool(re.match(r"^\d{1,3}(?:\.\d+)?$",t))
    in_h=False
    for y,g in rows(pg.get_text("words")):
        line=" ".join(w[4] for w in g)
        if re.search(r"EQUITY HOLDINGS|HOLDINGS\b",line) and "AUM" in line: in_h=True
        if not in_h: continue
        if line.strip().upper().startswith("INDUSTRY"): break        # industry section begins
        # LEFT column
        lname=[w[4] for w in g if w[0]<238 and not plainnum(w[4])]
        lpct=[w for w in g if 238<=w[0]<285 and plainnum(w[4])]
        # RIGHT column
        rname=[w[4] for w in g if 300<w[0]<525 and not plainnum(w[4])]
        rpct=[w for w in g if w[0]>=525 and plainnum(w[4])]
        for nmw,pw,side in ((lname,lpct,"L"),(rname,rpct,"R")):
            if not nmw: continue
            nm=re.sub(r"\s+"," "," ".join(nmw)).strip().rstrip(".")
            c=cat_word(nm)
            if c and not pw: curcat[side]=c; continue
            if not pw: continue
            up=nm.upper()
            if up in ("% OF AUM","HOLDINGS","EQUITY HOLDINGS","TOTAL","GRAND TOTAL"): continue
            if len(nm)<2: continue
            holdings.append({"security":nm,"weightPct":num(pw[0][4]),"rawCategory":curcat[side]})

    # industry/sector: two columns, name | %
    alloc=[]; in_i=False
    for y,g in rows(pg.get_text("words")):
        line=" ".join(w[4] for w in g)
        if line.strip().upper().startswith("INDUSTRY") and "AUM" in line: in_i=True; continue
        if not in_i: continue
        for x0,x1,px0 in ((25,266,266),(300,540,540)):
            nmw=[w[4] for w in g if x0<w[0]<x1 and not pctw(w[4]) and w[4] not in ("INDUSTRY","%","of","AUM")]
            pw=[w for w in g if w[0]>=px0 and re.match(r"^-?[\d.]+$",w[4])]
            if nmw and pw:
                lab=re.sub(r"\s+"," "," ".join(nmw)).strip()
                if len(lab)>2: alloc.append({"kind":"sector","label":lab,"weight":num(pw[-1][4])})

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":None,"benchmark":None,
            "manager":", ".join(manager) or None,"ytm":None,"modifiedDuration":None,"managedSummary":None,
            "aum":{"equity":None,"debt":None,"mmi":None,"total":aum},
            "returns":[],"allocations":alloc,"holdings":holdings,"_sectorpages":True}

def parse_companion(pg, fund):
    """Add ASSET ALLOCATION (F&U + Actual) and RETURNS to the in-progress fund."""
    text=pg.get_text(); rws=rows(pg.get_text("words"))
    # inception from "since inception (DD-Mon-YY)"
    im=re.search(r"since\s+inception\s*\((\d{1,2})-([A-Za-z]{3})-(\d{2,4})\)",text)
    if im and fund["inception"] is None:
        dd,mo,yy=im.groups(); yy=int(yy); yy=2000+yy if yy<100 else yy
        if mo.lower() in ABBR: fund["inception"]=f"{yy}-{ABBR[mo.lower()]:02d}-{int(dd):02d}"
    bm=re.search(r"Period\s+(?:Returns\s+)?Fund\s+(.+?)(?:\n|Returns)",text)
    if bm and not fund["benchmark"]: fund["benchmark"]=re.sub(r"\s+"," ",bm.group(1)).strip()[:40]

    # ASSET ALLOCATION (left column, under "F&U | ACTUAL"): each asset class is a label
    # block (EQUITIES / FIXED INCOME SECURITIES / MONEY MARKET INSTRUMENT) with its F&U
    # band ("min% - max%", x~100-150) and Actual% (x~170-200) on the block's FIRST row.
    # Names wrap, so collect all left-col %s with y and the nearest label by y.
    labelys=[]  # (y, canonical label)
    bandys=[]   # (y, [nums])  for the F&U "min - max"
    actys=[]    # (y, actual%)
    # The asset block (left, x<215) and the returns table (right, x>240) share y-rows,
    # so gate by y-range [F&U header .. SECTORAL/RATING profile], reading ONLY the left cols.
    in_a=False
    for y,g in rws:
        line=" ".join(w[4] for w in g)
        if "F&U" in line and "ACTUAL" in line: in_a=True; continue
        if not in_a: continue
        if re.search(r"SECTORAL|RATING PROFILE|MATURITY|PORTFOLIO CHARACTER",line,re.I): break
        lab=re.sub(r"\s+"," "," ".join(w[4] for w in g if w[0]<100 and not re.match(r'^[\d%]',w[4]))).upper()
        if "EQUIT" in lab: labelys.append((y,"Equity"))
        elif "FIXED" in lab or "INCOME" in lab: labelys.append((y,"Fixed Income"))
        elif "MONEY" in lab or "MARKET" in lab: labelys.append((y,"Money Market"))
        band=[num(w[4]) for w in g if 95<w[0]<168 and re.match(r"^\d{1,3}%?$",w[4]) and w[4] not in ("-","–")]
        if len(band)>=2: bandys.append((y,band[:2]))
        act=[num(w[4]) for w in g if 168<w[0]<215 and re.match(r"^\d{1,3}(?:\.\d+)?%$",w[4])]
        if act: actys.append((y,act[0]))
    seenlab=set()
    for ly,label in labelys:
        if label in seenlab: continue
        seenlab.add(label)
        band=min(bandys,key=lambda b:abs(b[0]-ly)) if bandys else None
        act=min(actys,key=lambda a:abs(a[0]-ly)) if actys else None
        if not any(a["kind"]=="asset" and a["label"]==label for a in fund["allocations"]):
            fund["allocations"].append({"kind":"asset","label":label,
                "weight":act[1] if act and abs(act[0]-ly)<14 else None,
                "fuMin":band[1][0] if band and abs(band[0]-ly)<14 else None,
                "fuMax":band[1][1] if band and abs(band[0]-ly)<14 else None})

    # RETURNS: "Returns <period> <fund%> <bench%>"
    PMAP=[("1 month","1M"),("6 month","6M"),("1 year","1Y"),("2 year","2Y"),("3 year","3Y"),
          ("4 year","4Y"),("5 year","5Y"),("since inception","Inception")]
    for y,g in rws:
        toks=[w[4] for w in g]
        lab=" ".join(w[4] for w in g if w[0]<340).lower()
        per=next((p for k,p in PMAP if k in lab),None)
        if not per: continue
        vals=[num(w[4]) for w in g if w[0]>=380 and pctw(w[4])]
        if vals and not any(r["period"]==per for r in fund["returns"]):
            fund["returns"].append({"period":per,"returnPct":vals[0],
                                    "benchmarkPct":vals[1] if len(vals)>1 else None})

def main():
    doc=fitz.open(sys.argv[1])
    month=detect_month(doc) or (sys.argv[2] if len(sys.argv)>2 else None)
    funds=[]; seen=set(); cur=None
    for pg in doc:
        f=parse_holdings_page(pg)
        if f:
            if f["sfin"] not in seen:
                seen.add(f["sfin"]); funds.append(f); cur=f
            else:
                cur=next((x for x in funds if x["sfin"]==f["sfin"]),None)
            continue
        if cur is not None:
            parse_companion(pg, cur)
    for f in funds: f.pop("_sectorpages",None)
    print(json.dumps({"month":month,"funds":funds}, indent=2, ensure_ascii=False))

if __name__=="__main__":
    main()
