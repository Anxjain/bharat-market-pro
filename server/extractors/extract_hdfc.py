#!/usr/bin/env python3
"""HDFC Life full Individual Fund Fact Sheet -> ExtractionZ JSON (no Gemini).

One fund per page (detect by "SFIN Code"). Layout (612x792):
  top: "<Name> as on <date>"; "SFIN Code : ULIF..."; AUM split Equity/Debt/MMI/Total
       (lakhs) aligned under their headers; "Inception Date :"; "NAV :"; benchmark "#...".
  returns: Period | Returns(x~249) | Benchmark(x~297) [Inception,10Y,7Y,5Y,3Y,2Y,1Y,6M,1M].
  holdings: LEFT column (name x~109-200 + weight x~298), stacked sub-tables
            Equity / Debentures&Bonds / Government Securities -> all are holdings.
  sector:   RIGHT column "Sector Allocation as per NIC 2008", name x~360-405 + weight x>405
            (bar-chart axis 0-100% at x~352 excluded).
asset allocation derived from the AUM split (Equity/Debt/MMI as % of Total). AUM in lakhs.

Usage: python extract_hdfc.py <pdf>
"""
import sys, re, json, math, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}
PCT=re.compile(r"^-?\d+(?:\.\d+)?%$")
RET_LABELS=[("Inception","Inception"),("10 Years","10Y"),("7 Years","7Y"),("5 Years","5Y"),
            ("3 Years","3Y"),("2 Years","2Y"),("1 Year","1Y"),("6 Months","6M"),("1 Month","1M")]
HOLD_SKIP=re.compile(r"^(equity|debt|total|grand total|others|debentures|government|"
                     r"securities|portfolio|% to fund|net current|deposits|money mkt)",re.I)

def detect_month(doc):
    c=Counter()
    for pg in doc:
        for mo,_,yr in re.findall(r"as on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(20\d{2})",pg.get_text(),re.I):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if not c: return None
    (yr,mo),_=c.most_common(1)[0]
    return f"{yr}-{mo:02d}"

def rows(ws,tol=2.5):
    out=[]
    for w in sorted(ws,key=lambda w:(w[1],w[0])):
        if out and abs(w[1]-out[-1][0])<=tol: out[-1][1].append(w)
        else: out.append([w[1],[w]])
    return [(round(y),sorted(g,key=lambda x:x[0])) for y,g in out]

def num(s):
    try: return float(s.replace(",","").replace("%",""))
    except: return None

def _wpts(items):
    """All explicit points of a vector path's items (Point objects only)."""
    P=[]
    for it in items:
        for v in it[1:]:
            if isinstance(v,fitz.Point): P.append((v.x,v.y))
    return P

# "Debt Rating Profile" is a legend + pie chart. Labels (Sovereign/AAA/AA+/...) sit in a
# legend column (x>462) each next to a tiny colour swatch; the matching pie WEDGE carries
# the same fill colour, and the % value text sits over its slice. Mapping is fully
# deterministic: swatch colour -> label (nearest legend row), wedge colour == swatch colour,
# and each wedge's angular direction (circular mean of its arc points about the shared pie
# apex) points at its % value text. Validated against page 3 (Sovereign 47.63 = GovtSec/Debt
# ratio) and the 4-slice Income fund.
def parse_rating(pg,rws):
    yr=None
    for y,g in rws:
        if any(w[4]=="Debt" for w in g) and any(w[4]=="Rating" for w in g) and any(w[4]=="Profile" for w in g):
            yr=y
    if yr is None: return []
    wedges=[]; sw=[]; lab=[]
    for dr in pg.get_drawings():
        if dr["type"]!="f" or not dr["fill"]: continue
        r=dr["rect"]; f=tuple(round(c,3) for c in dr["fill"])
        if not (r.x0>340 and yr-6<r.y0<yr+125): continue
        if f in ((1.0,1.0,1.0),(1.0,0.0,0.0)): continue   # white bg / red header bar
        kinds=[it[0] for it in dr["items"]]
        if "c" in kinds: wedges.append((f,_wpts(dr["items"])))
        elif kinds==["re"] and (r.x1-r.x0)<7 and (r.y1-r.y0)<7: sw.append((f,(r.y0+r.y1)/2))
    if not wedges or not sw: return []
    for y,g in rws:
        if not (yr-2<y<yr+130): continue
        lw=[w for w in g if w[0]>462 and not re.match(r"^-?\d",w[4]) and w[4] not in ("Debt","Rating","Profile")]
        if lw: lab.append((min(w[1] for w in lw)," ".join(w[4] for w in lw).strip()))
    if not lab: return []
    AXIS={f"{i}.00%" for i in range(0,101,10)}   # bar-chart axis ticks, not slice values
    vals=[]
    for y,g in rws:
        if not (yr-2<y<yr+130): continue
        for w in g:
            if w[0]>355 and PCT.match(w[4]) and w[4] not in AXIS:
                vals.append((num(w[4]),(w[0]+w[2])/2,(w[1]+w[3])/2))
    if not vals: return []
    cc=Counter((round(x,1),round(y,1)) for f,P in wedges for x,y in P)   # pie apex = shared point
    (cx,cy),_=cc.most_common(1)[0]
    col2lab={f:min(lab,key=lambda L:abs(L[0]-sy))[1] for f,sy in sw}
    out=[]; used=set(); seen=set()
    for f,P in wedges:
        angs=[math.atan2(y-cy,x-cx) for x,y in P if abs(x-cx)>2 or abs(y-cy)>2]
        if not angs: continue
        wd=math.atan2(sum(math.sin(a) for a in angs),sum(math.cos(a) for a in angs))  # circular mean dir
        best=None; bd=1e9
        for i,(vv,vx,vy) in enumerate(vals):
            if i in used: continue
            av=math.atan2(vy-cy,vx-cx); dd=abs(((av-wd+math.pi)%(2*math.pi))-math.pi)
            if dd<bd: bd=dd; best=i
        lbl=col2lab.get(f)
        if best is not None and lbl and lbl not in seen:
            used.add(best); seen.add(lbl)
            out.append({"kind":"rating","label":lbl,"weight":vals[best][0]})
    return out

def parse_page(pg):
    text=pg.get_text()
    sm=re.search(r"SFIN\s*Code\s*:?\s*(UL[IGP]F[0-9/]+[A-Za-z0-9 ]*?\d{3})(?=\s{2,}|\s+Equity|\s*\n|$)",text)
    if not sm: return None
    sfin=sm.group(1).strip()
    words=pg.get_text("words")
    rws=rows(words)

    nm=re.search(r"^(.*?)\s+as on\s+[A-Za-z]+\s+\d",text,re.M)
    name=nm.group(1).strip() if nm else sfin
    nav=None
    nv=re.search(r"NAV\s*:?\s*([\d,]+\.\d+)",text)
    if nv: nav=float(nv.group(1).replace(",",""))
    im=re.search(r"Inception\s*Date\s*:?\s*(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})",text)
    inception=None
    if im:
        d,mo,y=im.groups(); mo=mo.lower()[:3]
        if mo in ABBR: inception=f"{y}-{ABBR[mo]:02d}-{int(d):02d}"
    bm=re.search(r"#(.+?(?:Index|Bond Fund Index|TRI).*?)(?:\n|\*)",text)
    benchmark=re.sub(r"\s+"," ",bm.group(1)).strip() if bm else None

    # ---- AUM split: the row with the 4 lakhs figures under Equity/Debt/MMI/Total ----
    aum={"equity":None,"debt":None,"mmi":None,"total":None}
    # find header xs (and its y — compressed layouts put the value row only ~7px below)
    hx={}; hy=None
    for y,g in rws:
        toks={w[4]:w[0] for w in g}
        if "Equity" in toks and "Total" in toks and "Debt" in toks and y<140:
            hx={"equity":toks["Equity"],"debt":toks["Debt"],
                "mmi":toks.get("MMI",toks.get("&",430)),"total":toks["Total"]}
            hy=y; break
    if hx:
        # the value row just below the header (>=2: liquid funds show only MMI + Total,
        # Equity/Debt printed as "-"); pair to headers by x-proximity.
        for y,g in rws:
            vals=[(w[0],num(w[4])) for w in g if w[0]>340 and re.match(r"^[\d,]+\.\d+$",w[4])]
            if len(vals)>=2 and hy<y<=hy+22:
                # value-centric pairing: each value claims its nearest header, so a
                # dash column (Debt for liquid/midcap funds) is left None, not stolen.
                for vx,vv in vals:
                    key,hxx=min(hx.items(),key=lambda kv:abs(kv[1]-vx))
                    if abs(hxx-vx)<18 and aum[key] is None: aum[key]=vv
                break

    # ---- returns: Period rows, fund(x~249) + benchmark(x~297) ----
    returns=[]
    for lab,code in RET_LABELS:
        toks=lab.split()
        for y,g in rws:
            if y<134: continue   # skip the top block ("Inception Date :" etc.)
            txt=" ".join(w[4] for w in g if w[0]<200)
            if txt.startswith(lab) and "Date" not in txt:
                ps=[(w[0],num(w[4])) for w in g if 220<w[0]<320 and PCT.match(w[4])]
                ps.sort()
                if ps:
                    returns.append({"period":code,"returnPct":ps[0][1],
                                    "benchmarkPct":ps[1][1] if len(ps)>1 else None})
                break

    # ---- holdings: left column, CATEGORIZED — walk down tracking the section header
    # (Equity / Debentures&Bonds / Government Securities / Money Market) and tag each
    # security with its category. Skip the Others/Total/Grand-Total buckets. ----
    holdings=[]
    curcat=None
    def cat_of(t):
        s=t.lower().strip()
        if s in ("equity","equities"): return "Equity"
        if re.fullmatch(r"debentures?\s*[/&]?\s*bonds?", s) or s in ("bonds","debentures","corporate bonds","corporate debt"): return "Debentures/Bonds"
        if s in ("government securities","govt securities","gsec","g-sec","sovereign"): return "Government Securities"
        # money-market / NCA / deposits often appear as a single aggregate LINE (header+weight
        # in one) — esp. liquid funds whose whole portfolio is "Deposits, Money Mkt Securities
        # and Net Current Assets". Tag these "Money Market" so they're captured, not skipped.
        if re.search(r"money\s*mkt|money\s*market|\bmmi\b|net\s*current|deposits|treps|\bcblo\b|\brepo\b", s): return "Money Market"
        return None
    STOP=re.compile(r"^(debt parameters|portfolio yield|avg maturity|modified duration|debt maturity|"
                    r"debt rating|sector allocation|asset category|f&u mandate)",re.I)
    # Anchor to the "Portfolio" section header so the returns-footer "Note:" line above it is skipped.
    y_port=next((y for y,g in rws if " ".join(w[4] for w in g if w[0]<260).strip().lower()=="portfolio"), 210)
    # security name spans x83..~210 (the first words sit at x~83, NOT 100); the weight
    # is the %-word at x285-322 on the SAME row, but HDFC sometimes drifts it ~3px down
    # onto its own row -> borrow a lone orphan weight from the immediately following row.
    items=[(y,g) for y,g in rws if y>y_port]
    for idx,(y,g) in enumerate(items):
        hdrtxt=" ".join(w[4] for w in g if w[0]<260).strip()
        if STOP.match(hdrtxt.lower()): break
        nmw=[w for w in g if 55<w[0]<282 and not PCT.match(w[4])]
        wt=[w for w in g if 285<w[0]<322 and PCT.match(w[4])]
        if nmw and not wt and idx+1<len(items):     # weight drifted to next row?
            ny,ng=items[idx+1]
            if abs(ny-y)<=5:
                nwt=[w for w in ng if 285<w[0]<322 and PCT.match(w[4])]
                nnm=[w for w in ng if 55<w[0]<282 and not PCT.match(w[4])]
                if nwt and not nnm: wt=nwt
        nm2=" ".join(w[4] for w in nmw).strip()
        c=cat_of(nm2)
        if c and not wt:               # a pure category section header (no weight)
            curcat=c; continue
        if not nmw or not wt: continue
        low=nm2.lower()
        if len(nm2)<3 or low in ("total","grand total") or low.startswith("grand total"):
            continue  # section subtotals / grand total (would double-count) — but keep "Others"
        # "Others" is the factsheet's own aggregate of the untabulated tail of THIS section;
        # keep it (tagged with the section) so the portfolio sums to 100 exactly as printed.
        # `c` set here means a money-market/NCA aggregate LINE (header+weight in one) — keep
        # it as a holding tagged with that category; otherwise inherit the current section.
        holdings.append({"security":nm2,"weightPct":num(wt[-1][4]),"rawCategory":c or curcat or "Equity"})

    # ---- sector: right column "Sector Allocation as per NIC 2008". Name x355-425
    # (incl. "Others" + full multi-word labels), weight x>=425. NO sum-drop — a
    # balanced fund's sectors legitimately sum to only its equity portion. Keep all;
    # loose sanity only (each 0..100, max single <60). ----
    alloc=[]
    y_sec=next((y for y,g in rws if any(w[4]=="Sector" for w in g)),None)
    sec=[]
    if y_sec:
        for y,g in rws:
            if y<y_sec-2: continue
            nmw=[w for w in g if 355<w[0]<425 and not PCT.match(w[4]) and not re.match(r"^[\d.]+$",w[4])]
            wt=[w for w in g if w[0]>=425 and PCT.match(w[4])]
            if not nmw or not wt: continue
            lab=" ".join(w[4] for w in nmw).strip()
            if lab.lower().startswith(("sector","% to","as per","debt rating","debt maturity")) or len(lab)<3: continue
            sec.append({"kind":"sector","label":lab,"weight":num(wt[-1][4])})
    sec=[x for x in sec if x["weight"] is not None and 0<=x["weight"]<=100]
    seen=set()
    for x in sec:
        if x["label"] in seen: continue
        seen.add(x["label"]); alloc.append(x)

    # ---- Fund Manager(s) + No. Of Funds Managed summary ----
    # "Fund Manager" header (the word "Manager" at x>340); manager NAME rows below start with
    # an honorific (Mr/Ms/..) at x~355-405 with the funds-managed counts at x>=405. The column
    # headers "Equity Fund | Debt Fund | Hybrid Fund" (x>400) sit between header and 1st name.
    manager=None; managedSummary=None
    ymgr=next((y for y,g in rws if any(w[4]=="Manager" and w[0]>340 for w in g)),None)
    if ymgr is not None:
        # manager NAME rows: honorific at x355-405; keep only alphabetic words (drop the
        # funds-managed counts/dashes that can drift into the same x-band on compact layouts).
        names=[]
        for y,g in rws:
            if not (ymgr<y<ymgr+72): continue
            if not any(w[4].rstrip(".") in ("Mr","Ms","Mrs","Dr","Mt") and 340<w[0]<410 for w in g): continue
            nm_=" ".join(w[4] for w in g if 340<w[0]<410 and re.search(r"[A-Za-z]",w[4]) and w[4]!="-").strip()
            if nm_: names.append(nm_)
        if names: manager=", ".join(names)
        # "No. Of Funds Managed": column-header row "Equity Fund|Debt Fund|Hybrid Fund" gives xs;
        # the first counts row (may be the name row OR an adjacent row) holds the numbers/dashes.
        hy=None; hcol={}
        for y,g in rws:
            if ymgr-6<=y<ymgr+40:
                tx={w[4]:w[0] for w in g if w[0]>380}
                if "Equity" in tx and "Debt" in tx and "Hybrid" in tx:
                    hcol={"Equity":tx["Equity"],"Debt":tx["Debt"],"Hybrid":tx["Hybrid"]}; hy=y; break
        if hcol:
            for y,g in rws:
                if not (hy<y<hy+34): continue
                nums=[(w[0],w[4]) for w in g if w[0]>=hcol["Equity"]-8 and re.match(r"^\d+$",w[4])]
                if not nums: continue
                col={}                       # each number claims its single nearest column
                for x,v in nums:
                    k=min(hcol,key=lambda c:abs(hcol[c]-x))
                    if abs(hcol[k]-x)<22 and k not in col: col[k]=v
                parts=[f"{k} - {col[k]}" for k in ("Equity","Debt","Hybrid") if k in col]
                if parts: managedSummary=" | ".join(parts); break

    # ---- Debt Parameters: Portfolio Yield (%) -> ytm ; Modified Duration (In Years) -> md.
    # Label x drifts (left or bottom column) but the value sits at x~290-310 on the same row.
    ytm=None; modifiedDuration=None
    for y,g in rws:
        s=" ".join(w[4] for w in g)
        if re.search(r"Portfolio\s+Yield",s):
            v=[num(w[4]) for w in g if 280<w[0]<345 and re.match(r"^[\d.,]+%?$",w[4])]
            if v and ytm is None: ytm=v[0]
        elif re.search(r"Modified\s+Duration",s):
            v=[num(w[4]) for w in g if 280<w[0]<345 and re.match(r"^[\d.,]+%?$",w[4])]
            if v and modifiedDuration is None: modifiedDuration=v[0]

    # ---- Debt Rating Profile (pie + legend) -> rating allocations ----
    alloc.extend(parse_rating(pg,rws))

    # ---- asset allocation from AUM split ----
    if aum["total"] and aum["total"]>0:
        t=aum["total"]
        for key,label in (("equity","Equity"),("debt","Debt"),("mmi","Money Market")):
            if aum[key] is not None:
                alloc.append({"kind":"asset","label":label,"weight":round(aum[key]/t*100,2)})

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
            "ytm":ytm,"modifiedDuration":modifiedDuration,"managedSummary":managedSummary,
            "aum":aum,"returns":returns,"allocations":alloc,"holdings":holdings}

def main():
    doc=fitz.open(sys.argv[1])
    month=detect_month(doc) or (sys.argv[2] if len(sys.argv)>2 else None)
    funds=[]; seen=set()
    for pg in doc:
        f=parse_page(pg)
        if f and f["sfin"] not in seen:
            seen.add(f["sfin"]); funds.append(f)
    print(json.dumps({"month":month,"funds":funds},indent=2,ensure_ascii=False))

if __name__=="__main__":
    main()
