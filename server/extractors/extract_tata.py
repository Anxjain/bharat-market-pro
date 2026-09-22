#!/usr/bin/env python3
"""Tata AIA Life per-fund factsheet PDFs -> ExtractionZ JSON (no Gemini).

ONE PDF = ONE FUND (single page, 666x918, master template "Fund Assure,
Investment Report, <Month> <Year>"). main() globs every *.pdf in a directory
and emits one combined {"month","funds":[...]}.

Layout (consistent across all funds; learned from page.get_text("words")):
  Header  (top row, x<265)        : "<NAME> FUND"; SFIN "ULIF 060 15/07/14 MCF 110"
  Fund Details (left col, x<265)  : NAV as on .. ; Benchmark: .. ; Corpus .. Crs. ;
                                    Fund Manager: .. ; Co-Fund Manager: .. ; Modified Duration ..
  Portfolio (TWO columns, x287-455 left / x462-640 right) "Instrument | % Of NAV"
        Read COLUMN-MAJOR: entire LEFT column then entire RIGHT column, with a
        single running category. Tata prints a section (e.g. Government
        Securities) that flows from the bottom of the left column into the right
        column, so column-major + running curcat assigns every holding correctly.
        Section header rows ("Equity", "Government Securities", "Corporate Bonds")
        carry the section SUBTOTAL -> set curcat, NOT counted as a holding.
        Aggregate rows ("Other Equity", "Other Government Securities", "Other
        Corporate Bonds") -> holdings under curcat. "MMI & Others" / "Cash" /
        "Net Current Assets" -> holding with its OWN verbatim rawCategory.
        Value may sit 1-3 rows BELOW its name (scan-ahead pairing per column).
  Fund Performance (returns table) : Period | Date | NAV | Index | NAV-Change% |
                                    Index-Change%  -> fund=NAV-Change, benchmark=Index-Change.
                                    Inception date read from the "Since Inception" row.
  Asset Mix table ("Instrument .. Asset Mix as per F&U .. Actual Asset Mix")
        location varies: LEFT (equity/hybrid funds) or RIGHT (debt funds). Detected
        by its "F&U" header; columns x-gated from the header span. Rows:
        Equity / Debt / Money Market & Others = min% - max% actual%  (kind=asset).
  Sector Allocation (right col)    : NIC industry names (wrapped) + %  (kind=sector).
  Rating Profile (left, debt only) : stacked vertical bar -> labels & values both
                                    sorted by y and zipped  (kind=rating).
  Maturity Profile (left, debt only): vertical bars -> value matched to x-axis
                                    bucket by x-position  (kind=maturity).
  AUM (in Crores) (left col)       : Equity / Debt / MMI & Others split.

AUM UNIT = CRORE  ("Corpus .. Crs.", "AUM (in Crores)").
Month auto-detected from "Investment Report, <Month> <Year>" (most common);
falls back to argv[2] (YYYY-MM).

Usage: PYTHONIOENCODING=utf-8 python extract_tata.py <dir-of-pdfs> [YYYY-MM-fallback]
"""
import sys, re, json, glob, os, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
ABBR={m[:3]:v for m,v in MONTHS.items()}
PCT=re.compile(r"^-?\d+(?:\.\d+)?%$")
WT=re.compile(r"^-?\d+\.\d+$")                       # holding weight token
DATEW=re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{2,4}$")

# Exact section-header labels (uppercased). A portfolio row whose whole label
# equals one of these is a section header carrying a subtotal -> set category,
# do NOT emit as a holding. Aggregates ("Other ...", "MMI & Others") are NOT here.
SECTION={
 "EQUITY","OTHER EQUITY","GOVERNMENT SECURITIES","CENTRAL GOVERNMENT SECURITIES",
 "STATE GOVERNMENT SECURITIES","CORPORATE BONDS","CORPORATE BOND","CORPORATE DEBT",
 "DEBT","BONDS","DEBENTURES","MONEY MARKET","MONEY MARKET INSTRUMENTS","FIXED DEPOSIT",
 "FIXED DEPOSITS","MUTUAL FUND","MUTUAL FUNDS","INFRASTRUCTURE","REITS","INVITS",
 "ADDITIONAL TIER I BONDS","TREASURY BILLS","ZERO COUPON BONDS","PASS THROUGH CERTIFICATES",
}
# "Other Equity" must stay a holding (aggregate), so drop the OTHER* variants:
SECTION={s for s in SECTION if not s.startswith("OTHER")}
SELF=re.compile(r"^(MMI|Cash|Net Current|Money Market|TREPS|Tri[- ]?Party|Reverse Repo|Current Assets)",re.I)
SKIP_HOLD=re.compile(r"^(Total|Grand Total|Portfolio Total)$",re.I)

def rows(ws,tol=2.5):
    out=[]
    for w in sorted(ws,key=lambda w:(w[1],w[0])):
        if out and abs(w[1]-out[-1][0])<=tol: out[-1][1].append(w)
        else: out.append([w[1],[w]])
    return [(round(y,1),sorted(g,key=lambda x:x[0])) for y,g in out]

def num(s):
    try: return float(s.replace(",","").replace("%","").strip())
    except: return None

def jn(words):
    return re.sub(r"\s+"," "," ".join(w[4] for w in words)).strip()

def month_of(text):
    m=re.search(r"Investment Report,\s+([A-Za-z]+)\s+(20\d{2})",text)
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(2)}-{MONTHS[m.group(1).lower()]:02d}"
    return None

def parse_date(tok):
    m=re.match(r"(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$",tok)
    if not m: return None
    d,mo,y=m.groups()
    if mo.lower() not in ABBR: return None
    y=int(y); y=2000+y if y<100 else y
    return f"{y}-{ABBR[mo.lower()]:02d}-{int(d):02d}"

def yof(rws,pred):
    for y,g in rws:
        if pred(jn(g)): return y
    return None

# ----- column holdings: pair name with weight, value may sit 1-3 rows below -----
def column_items(colrows):
    """colrows = [(y, name_words, weight_words)] sorted by y for ONE column.
    Returns [(name, weight_or_None)] in reading order. A holding's % may sit on a
    separate row 1-3 rows BELOW its name (most funds, e.g. Whole Life Income) OR
    1-3 rows ABOVE it (e.g. Apex Pension Return Lock-In) because the bold weight
    and the name render on slightly different baselines. Pair in BOTH directions:
      pend_name : a name still waiting for its weight (weight-below)
      pend_wt   : a weight still waiting for its name (weight-above)."""
    items=[]; pend_name=None; pend_wt=None
    for y,nw,ww in colrows:
        name=jn(nw)
        if name and re.search(r"Instrument|% Of NAV",name): continue
        wt=num(ww[-1][4]) if ww else None
        if name and wt is not None:                       # complete row
            if pend_name is not None: items.append((pend_name,None)); pend_name=None
            pend_wt=None
            items.append((name,wt))
        elif name:                                        # name only
            if pend_wt is not None: items.append((name,pend_wt)); pend_wt=None
            elif pend_name is not None: items.append((pend_name,None)); pend_name=name
            else: pend_name=name
        elif wt is not None:                              # weight only
            if pend_name is not None: items.append((pend_name,wt)); pend_name=None
            else: pend_wt=wt                              # hold for the next name
    if pend_name is not None: items.append((pend_name,None))
    return items

def parse_page(pg):
    text=pg.get_text(); words=pg.get_text("words")
    if "% Of NAV" not in text or "Investment Report" not in text:
        return None,None                         # not a per-fund factsheet page
    rws=rows(words)
    month=month_of(text)

    # ---- left-column reconstructed text (x<265) -> clean of right-column holdings ----
    leftText="\n".join(jn([w for w in g if w[0]<265]) for y,g in rws)

    sm=re.search(r"\b(UL[IGP]F\s*\d{3}\s*\d{2}/\d{2}/\d{2,4}\s*[A-Za-z0-9]+\s*\d{3})\b",text)
    if not sm: return None,None
    sfin=re.sub(r"\s+","",sm.group(1))

    # name: topmost row, words x<265
    name=sfin
    for y,g in rws:
        t=jn([w for w in g if w[0]<265])
        if t and "FUND" in t.upper():
            name=t.title(); break
        if t:
            name=t.title(); break

    nv=re.search(r"NAV as on[^\n]*?:\s*[^\d\n]*([\d,]+\.\d+)",leftText)
    nav=num(nv.group(1)) if nv else None
    cp=re.search(r"Corpus as on[^\n]*?:\s*[^\d\n]*([\d,]+\.\d+)",leftText)
    total_aum=num(cp.group(1)) if cp else None
    bm=re.search(r"Benchmark:\s*(.+)",leftText)
    benchmark=re.sub(r"\s+"," ",bm.group(1)).strip() if bm else None
    md=re.search(r"Modified Duration\s+([\d.]+)",leftText)
    modur=num(md.group(1)) if md else None
    fm=re.search(r"(?<!-)Fund Manager:\s*(.+)",leftText)
    manager=re.sub(r"\s+"," ",fm.group(1)).strip() if fm else None
    cf=re.search(r"Co-Fund Manager:\s*(.+)",leftText)
    if cf:
        co=re.sub(r"\s+"," ",cf.group(1)).strip()
        if co and co!="-" and "Mr" in co and manager: manager=f"{manager} & {co}"

    # ================= PORTFOLIO HOLDINGS (column-major) =================
    # Detect the portfolio columns (1 or 2) from the header "Instrument | % Of NAV
    # [ Instrument | % Of NAV ]" row: each "NAV" token marks a weight column, each
    # "Instrument" token marks a name column. Liquid/Discontinued funds print a
    # SINGLE column with the weight far-right (~x609); equity/debt/hybrid print two.
    hdr=None
    for y,g in rws:
        t=jn(g)
        if "Instrument" in t and "Of NAV" in t and y<210: hdr=g; break
    cols=[]
    if hdr:
        navs=sorted(w[0] for w in hdr if w[4]=="NAV")
        insts=sorted(w[0] for w in hdr if w[4]=="Instrument")
        for i,nx in enumerate(navs):
            nstart=insts[i] if i<len(insts) else (insts[0] if insts else nx-150)
            cols.append((nstart-6,nx-30,nx-30,nx+14))   # name_lo,name_hi,wt_lo,wt_hi
    if not cols:
        cols=[(283,430,430,458),(462,612,612,642)]
    y_inst=yof(rws,lambda t:"Instrument" in t and "Of NAV" in t) or 137
    y_perf=yof(rws,lambda t:"Fund" in t and "Performance" in t) or 9e9
    streams=[]
    for nlo,nhi,wlo,whi in cols:
        cr=[]
        for y,g in rws:
            if not (y_inst<=y<y_perf): continue
            nw=[w for w in g if nlo<=w[0]<nhi]
            ww=[w for w in g if wlo<=w[0]<whi and WT.match(w[4])]
            if nw or ww: cr.append((y,nw,ww))
        streams.append(cr)
    items=[]
    for cr in streams: items+=column_items(cr)
    holdings=[]; curcat="Equity"
    for nm,wt in items:
        if not nm: continue
        U=nm.upper()
        if U in SECTION:                       # section header / subtotal
            curcat=nm; continue
        if wt is None: continue                # orphan name fragment
        if SKIP_HOLD.match(nm): continue       # Total / Grand Total
        cat=nm if SELF.match(nm) else curcat
        holdings.append({"security":nm,"weightPct":wt,"rawCategory":cat})

    # ================= RETURNS (Fund Performance table) =================
    RET=[("Last 1 Month","1M"),("Last 3 Months","3M"),("Last 6 Months","6M"),("YTD","YTD"),
         ("Last 1 Year","1Y"),("Last 2 Years","2Y"),("Last 3 Years","3Y"),("Last 4 Years","4Y"),
         ("Last 5 Years","5Y"),("Last 7 Years","7Y"),("Last 10 Years","10Y"),("Since Inception","Inception")]
    LBL={a:b for a,b in RET}
    inception=None; returns=[]
    for y,g in rws:
        if y<=y_perf: continue
        lab=jn([w for w in g if 288<=w[0]<352])
        lab=re.sub(r"[*\s]+"," ",lab).strip()       # new funds print "Since Inception*"
        code=LBL.get(lab)
        if not code: continue
        if code=="Inception":
            dt=next((w[4] for w in g if 340<w[0]<430 and DATEW.match(w[4])),None)
            if dt: inception=parse_date(dt)
        pcts=[(w[0],num(w[4])) for w in g if w[0]>500 and PCT.match(w[4])]
        pcts.sort()
        if pcts:
            returns.append({"period":code,"returnPct":pcts[0][1],
                            "benchmarkPct":pcts[1][1] if len(pcts)>1 else None})

    alloc=[]

    # ================= ASSET MIX (kind=asset, min/max/actual) =================
    hdr=None
    for y,g in rws:
        if re.search(r"F&U",jn(g)) and "Asset" in jn(g):
            hdr=(y,g); break
    if hdr:
        hy,hg=hdr
        # Anchor the table's x-region to the F&U header's OWN tokens only. When the
        # Asset Mix table sits on the RIGHT, its header row shares a y-band with the
        # left-column "AUM | Equity .." cells; including those would bleed the region
        # left and mislabel rows (e.g. "Debt Equity").
        hw=[w for w in hg if w[4] in ("Instrument","Asset","Mix","as","per","F&U","Actual")]
        hx0=min(w[0] for w in hw)-6; hx1=max(w[2] for w in hw)+26
        for y,g in rws:
            if not (hy<y<hy+95): continue
            reg=[w for w in g if hx0<=w[0]<=hx1]
            lab=jn([w for w in reg if not PCT.match(w[4]) and w[4]!="-" and not w[4].endswith("*")])
            lab=re.sub(r"\s*\*\s*$","",lab).strip()
            if not re.match(r"^(Equity|Debt|Money)",lab): continue
            ps=sorted((w[0],num(w[4])) for w in reg if PCT.match(w[4]))
            label="Money Market & Others" if lab.lower().startswith("money") else lab
            fuMin=ps[0][1] if len(ps)>=1 else None
            fuMax=ps[1][1] if len(ps)>=2 else None
            act=ps[2][1] if len(ps)>=3 else None
            # Tata's "Asset Mix as per F&U / Actual Asset Mix" table = the Funds&Use
            # mandate band -> kind "fnu" (fuMin/fuMax = band, weight = actual). Also
            # surface the actual as a plain "asset" allocation for display layers.
            alloc.append({"kind":"fnu","label":label,"fuMin":fuMin,"fuMax":fuMax,"weight":act})
            if act is not None:
                alloc.append({"kind":"asset","label":label,"weight":act})

    # ================= SECTOR ALLOCATION (kind=sector, wrapped names) =================
    y_sec=yof(rws,lambda t:"Sector" in t and "Allocation" in t)
    if y_sec:
        snames=[]; spcts=[]
        for y,g in rws:
            if y<=y_sec: continue
            row_pcts=[w for w in g if 460<=w[0]<615 and PCT.match(w[4])]
            if len(row_pcts)>=5: continue                 # x-axis tick row
            for w in g:
                if 285<=w[0]<460 and not PCT.match(w[4]):
                    snames.append((y,w[0],w[4]))
            for w in row_pcts:
                spcts.append((y,num(w[4])))
        for py,pv in spcts:
            block=[(wx,t) for (wy,wx,t) in snames if abs(wy-py)<=9]
            lab=re.sub(r"\s+"," "," ".join(t for _,t in sorted(block))).strip()
            if len(lab)>=3:
                alloc.append({"kind":"sector","label":lab,"weight":pv})

    # ================= RATING PROFILE (kind=rating; stacked bar -> zip by y) ====
    y_rate=yof(rws,lambda t:"Rating" in t and "Profile" in t)
    if y_rate:
        # band-end: only LEFT-column sections below (the "Asset Mix" header can sit
        # on the RIGHT column just under the Rating header and would wrongly truncate).
        ends=[yof(rws,lambda t:k in t) for k in ("Maturity Profile","AUM (in Crores)")]
        ends=[e for e in ends if e and e>y_rate]
        y_end=min(ends) if ends else y_rate+160
        labs=[]; vals=[]
        for y,g in rws:
            if not (y_rate<y<y_end): continue
            for w in g:
                if PCT.match(w[4]) and w[0]<170: vals.append((y,num(w[4])))
            lw=[w for w in g if 165<=w[0]<270 and not PCT.match(w[4])]
            if lw: labs.append((y,jn(lw)))
        labs.sort(); vals.sort()
        if labs and len(labs)==len(vals):
            for (ly,lab),(vy,v) in zip(labs,vals):
                alloc.append({"kind":"rating","label":lab,"weight":v})

    # ================= MATURITY PROFILE (kind=maturity; bars -> match by x) =====
    y_mat=yof(rws,lambda t:"Maturity" in t and "Profile" in t)
    if y_mat:
        ends=[yof(rws,lambda t:k in t) for k in ("AUM (in Crores)","Sector Allocation")]
        ends=[e for e in ends if e and e>y_mat]
        y_end=min(ends) if ends else y_mat+150
        axis=None
        for y,g in rws:
            if y_mat<y<y_end+25 and re.search(r"Year",jn(g)):
                axis=[(w[0],w[2],w[4]) for w in g if 60<=w[0]<260]; break
        if axis:
            axis.sort()
            groups=[]; cur=[axis[0]]
            for a in axis[1:]:
                if a[0]-cur[-1][1]>9: groups.append(cur); cur=[a]   # split buckets on wide x-gaps
                else: cur.append(a)
            groups.append(cur)
            cats=[((g[0][0]+g[-1][1])/2," ".join(t for _,_,t in g)) for g in groups]
            for y,g in rws:
                if not (y_mat<y<y_end): continue
                for w in g:
                    if 60<=w[0]<260 and PCT.match(w[4]):
                        cx,lab=min(cats,key=lambda c:abs(c[0]-w[0]))
                        alloc.append({"kind":"maturity","label":lab,"weight":num(w[4])})

    # ================= AUM SPLIT (left col, "AUM (in Crores)") =================
    aum={"equity":None,"debt":None,"mmi":None,"total":total_aum}
    y_aum=yof(rws,lambda t:"AUM" in t and "Crores" in t)
    if y_aum:
        AUMV=re.compile(r"^-?[\d,]+\.\d+$")        # AUM may carry thousands commas (10,243.12)
        for y,g in rws:
            if not (y_aum<y<y_aum+90): continue
            reg=[w for w in g if w[0]<265]
            lab=jn([w for w in reg if not AUMV.match(w[4]) and w[4]!="-"]).lower()
            val=next((num(w[4]) for w in reg if 170<w[0]<265 and AUMV.match(w[4])),None)
            if lab.startswith("equity"): aum["equity"]=val
            elif lab.startswith("debt"): aum["debt"]=val
            elif lab.startswith("mmi") or lab.startswith("money"): aum["mmi"]=val

    fund={"sfin":sfin,"name":name,"class":"Group" if sfin.startswith("ULGF") else "Individual","category":None,
          "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
          "ytm":None,"modifiedDuration":modur,"managedSummary":None,
          "aum":aum,"returns":returns,"allocations":alloc,"holdings":holdings}
    return fund,month

def main():
    # Each *.pdf may be a single-fund factsheet OR the master "Fund Assure" booklet
    # (cover + performance-summary tables + every per-fund factsheet page). We
    # iterate EVERY page of EVERY pdf, accept any page that is a per-fund
    # factsheet, and dedup by SFIN -> the union covers all funds, dropping none.
    d=sys.argv[1] if len(sys.argv)>1 else "pdfs/tata"
    pdfs=sorted(glob.glob(os.path.join(d,"*.pdf")))
    funds=[]; seen=set(); months=Counter()
    for p in pdfs:
        b=os.path.basename(p)
        try: doc=fitz.open(p)
        except Exception as e:
            print(f"ERR open {b}: {e}",file=sys.stderr); continue
        for pi,pg in enumerate(doc):
            try: f,m=parse_page(pg)
            except Exception as e:
                print(f"ERR {b} p{pi}: {e}",file=sys.stderr); continue
            if not f: continue
            if f["sfin"] in seen: continue
            # backfillLoad enforces allocation kind in {asset,sector,fnu,rating};
            # "maturity" is parsed (above) but has no loader slot, so drop it here.
            f["allocations"]=[a for a in f["allocations"]
                              if a["kind"] in ("asset","sector","fnu","rating")]
            seen.add(f["sfin"]); funds.append(f)
            if m: months[m]+=1
    month=months.most_common(1)[0][0] if months else (sys.argv[2] if len(sys.argv)>2 else None)
    print(json.dumps({"month":month,"funds":funds},indent=2,ensure_ascii=False))

if __name__=="__main__":
    main()
