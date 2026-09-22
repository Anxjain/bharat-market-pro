#!/usr/bin/env python3
"""Canara HSBC Life "Investment Newsletter" -> ExtractionZ JSON (no Gemini).

One fund per page (detect by the "ULIF...136" SFIN token). Page 612x792.

LAYOUT (learned from the May-2026 sheet, captured 1:1):
  Header / Fund Details (clean text, right + left):
     name (from "The SFIN for <NAME> is ULIF...136"), SFIN, as-on date -> month,
     NAV ("NAV as on .. : Rs. .."), inception ("DATE OF INCEPTION .."),
     benchmark ("BENCHMARK: .."), modified duration ("Modified Duration ..: X years"),
     fund manager(s) + "Number of Funds Managed .." summary.   (Canara prints NO YTM.)
  Asset-mix donuts (top-left, clean text): up to 4 of
     EQUITY / DEBT / GOVERNMENT SECURITIES / MONEY MARKET RELATED INSTRUMENTS, each with
     a Min%-Max% band, an ACTUAL ALLOCATION %, and an AUM (Rs. Crore) figure.
     Per-asset AUM is matched to its asset by value (= total x actual%); total AUM = the
     largest crore figure printed.
  Categorised holdings (right column): EQUITY / GOVERNMENT SECURITIES / CORPORATE DEBT
     section SUBTOTALS (skipped) + every leaf security (weight = RIGHTMOST %, since a
     coupon% may prefix the name), incl. "Others" and the "MONEY MARKET INSTRUMENTS &
     OTHERS" leaf, so holdings sum ~100. rawCategory = the verbatim printed section label.
  Sector exposure (bottom-left): NIC names (clean legend, top->bottom) paired by order
     with the bar values (OBFUSCATED subset font, decoded +29).
  Returns chart (top-right, OBFUSCATED, decoded +29): FUND (+ BENCHMARK if not "NA")
     series; periods assigned by bar-count from Canara's canonical descending order
     [Inception,5Y,3Y,2Y,1Y,6M,1M].
  Credit-Rating & Maturity profiles (clean text): captured as rating/maturity allocations.

FONT OBFUSCATION: chart numbers use a subset ZurichBT-RomanCondensed whose glyph codes
are shifted; PyMuPDF returns control-chars. rawdict + chr(ord(c)+29) recovers them
reliably for the VALUE font (verified: sector bars sum ~100, Inception return matches NAV
CAGR). The BoldCondensed axis/period-label font uses a different/non-uniform mapping, so
periods are derived by bar-count rather than decoded. AUM unit: Rs. Crore.

Usage: PYTHONIOENCODING=utf-8 python extract_canara.py <pdf>
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
INTPCT=re.compile(r"^\d+%$")
DECPCT=re.compile(r"^-?\d+\.\d+%$")
CRORE=re.compile(r"^\d[\d,]*\.\d$")

def num(s):
    try: return float(str(s).replace(",","").replace("%","").strip())
    except: return None

def detect_month(doc):
    pat=re.compile(r"NAV as on\s+\d+\w*\s+([A-Za-z]+)\s+(20\d{2})",re.I)
    c=Counter()
    for pg in doc:
        for mo,yr in pat.findall(pg.get_text()):
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

# ---- obfuscated chart values: rawdict glyphs in the VALUE font, decoded +29 ----
def decoded_values(pg):
    """Return (returns, sector) lists of (x,y,decoded) from the obfuscated value font."""
    R=[]; S=[]
    for b in pg.get_text("rawdict")["blocks"]:
        if "lines" not in b: continue
        for ln in b["lines"]:
            for sp in ln["spans"]:
                base=sp["font"].split("+")[-1]
                if base not in ("ZurichBT-RomanCondensed","ArialMT"): continue   # value fonts only
                ch=sp["chars"]
                if not any(ord(c["c"])<32 for c in ch): continue   # only obfuscated spans
                dec="".join(chr(ord(c["c"])+29) for c in ch)
                x,y=round(sp["bbox"][0]),round(sp["bbox"][1])
                if "%" in dec and x>=330:            # returns chart (right)
                    v=num(dec)
                    if v is not None: R.append((x,y,v))
                elif "." in dec and 40<=x<300 and "%" not in dec:   # sector bars (left), exclude int axis ticks
                    v=num(dec)
                    if v is not None: S.append((x,y,v))
    return sorted(R),sorted(S)

CANON=["5Y","3Y","2Y","1Y","6M","1M"]   # tail periods (descending); Inception always leftmost
def parse_returns(pg,text):
    R,_=decoded_values(pg)
    if not R: return []
    hasbench = not re.search(r"BENCHMARK:\s*NA\b",text)
    vals=[v for _,_,v in R]   # already sorted by x
    if hasbench and len(vals)%2==0 and len(vals)>=2:
        pairs=[(vals[i],vals[i+1]) for i in range(0,len(vals),2)]   # (fund,benchmark)
    else:
        pairs=[(v,None) for v in vals]                              # single FUND series
    n=len(pairs)
    if n<1 or n>7:
        periods=[None]*n
    else:
        periods=["Inception"]+CANON[len(CANON)-(n-1):] if n>=1 else []
    out=[]
    for i,(f,bnc) in enumerate(pairs):
        out.append({"period":periods[i] if i<len(periods) else None,
                    "returnPct":f,"benchmarkPct":bnc})
    return out

def parse_sectors(pg,text):
    _,S=decoded_values(pg)
    weights=[v for _,_,v in S]   # sorted by x = chart order
    # sector legend names (clean text, x<270, below the SECTOR header, merge wrapped lines)
    ws=pg.get_text("words")
    y_sec=next((w[1] for w in ws if w[4]=="SECTOR" and w[0]<160),None)
    if y_sec is None: y_sec=next((w[1] for w in ws if "INDUSTRY" in w[4] and w[0]<160),None)
    BLEED={"CREDIT","RATING","MATURITY","PROFILE"}   # rating/maturity panel words overlapping legend rows
    names=[]
    if y_sec is not None:
        for y,g in rows(ws):
            if y<=y_sec+4: continue
            toks=[w for w in g if w[0]<270 and re.search(r"[A-Za-z]",w[4]) and w[4] not in BLEED]
            if not toks: continue
            line=re.sub(r"\s+"," "," ".join(w[4] for w in toks)).strip()
            if not line: continue
            low=line.lower()
            if low.startswith("*") or "includes gsec" in low or "fund manager" in low \
               or "number of funds" in low or "past performance" in low:
                break
            if "equivalent" in low or "below a" in low \
               or re.search(r"up\s?to 1 year|above 7 years|more than 1 year",low):
                continue                          # rating/maturity bucket label, not a sector
            # merge a continuation line that begins lowercase (e.g. "and botanical products")
            if names and re.match(r"^[a-z&]", line):
                names[-1]=names[-1]+" "+line
            else:
                names.append(line)
    out=[]
    if names and len(names)==len(weights):
        for nm,wt in zip(names,weights):
            out.append({"kind":"sector","label":nm,"weight":wt})
    elif names:                       # counts disagree -> capture labels, weight null
        for nm in names:
            out.append({"kind":"sector","label":nm,"weight":None})
    return out

ASSETS=[  # (clean label, anchor predicate on consecutive words)
  ("Equity", ("EQUITY","AND","EQUITY")),
  ("Debt", ("DEBT","AND","DEBT")),
  ("Government Securities", ("GOVERNMENT","SECURITIES")),
  ("Money Market", ("MONEY","MARKET")),
]
def parse_assets(pg):
    ws=pg.get_text("words")
    rws=rows(ws)
    # locate asset-donut label anchors in the left region (x<260, y<320)
    anchors=[]
    for label,seq in ASSETS:
        found=None
        for y,g in rws:
            txt=[w[4] for w in g]
            for k in range(len(g)-len(seq)+1):
                if g[k][0]<260 and y<345 and tuple(txt[k:k+len(seq)])==seq:
                    found=(g[k][0],y); break
            if found: break
        if found: anchors.append((label,found[0],found[1]))
    # candidate value clusters in the left region
    minmax=[]; actual=[]; crore=[]
    for y,g in rws:
        if y>=345: continue
        ints=[(w[0],int(w[4][:-1])) for w in g if w[0]<260 and INTPCT.match(w[4])]
        if len(ints)==2:
            cx=(ints[0][0]+ints[1][0])/2
            minmax.append((cx,y,min(i[1] for i in ints),max(i[1] for i in ints)))
        for w in g:
            if w[0]<260 and DECPCT.match(w[4]):
                actual.append((w[0],y,num(w[4])))
            if w[0]<260 and CRORE.match(w[4]):
                crore.append(num(w[4]))
    total=max(crore) if crore else None
    pool=list(crore)
    if total is not None: pool.remove(total)
    def nearest(cands,ax,ay):
        return min(cands,key=lambda c:(c[0]-ax)**2+(c[1]-ay)**2) if cands else None
    alloc=[]; aum={"equity":None,"debt":None,"mmi":None,"total":total}
    keymap={"Equity":"equity","Debt":"debt","Government Securities":"debt","Money Market":"mmi"}
    for label,ax,ay in anchors:
        a=nearest(actual,ax,ay)
        mm=nearest(minmax,ax,ay)
        w=a[2] if a else None
        e={"kind":"asset","label":label,"weight":w,
           "fuMin":(mm[2] if mm else None),"fuMax":(mm[3] if mm else None)}
        alloc.append(e)
        # match the printed per-asset AUM by value (= total x actual%)
        if total is not None and w is not None and pool:
            exp=total*w/100.0
            best=min(pool,key=lambda c:abs(c-exp))
            if abs(best-exp)<=max(2.0,0.05*total):
                k=keymap.get(label)
                if k and aum.get(k) is None: aum[k]=best
                pool.remove(best)
    return alloc,aum

def parse_holdings(pg):
    ws=pg.get_text("words")
    y_top=next((w[1] for w in ws if w[4]=="HOLDINGS" and w[0]>300),None)
    if y_top is None: return []
    rws=rows(ws)
    # build holding rows: name (x 300..540) + weight (rightmost % at x>540)
    rec=[]
    for y,g in rws:
        if y<=y_top: continue
        nmw=[w for w in g if 300<w[0]<545]
        wt=[w for w in g if w[0]>=540 and re.match(r"^-?\d+(?:\.\d+)?%$",w[4])]
        if not nmw or not wt: continue
        name=re.sub(r"\s+"," "," ".join(w[4] for w in nmw)).strip()
        rec.append((name,num(wt[-1][4])))
    KNOWN_HDR=re.compile(r"^(EQUITY|GOVERNMENT SECURITIES|CORPORATE DEBT|CORPORATE BONDS?|"
                         r"MONEY MARKET INSTRUMENTS(?: & OTHERS)?|DEBT|NET CURRENT ASSETS|"
                         r"FIXED DEPOSITS?|TREASURY BILLS?|UNIT FUNDS?)$")
    def is_header(nm):
        return bool(KNOWN_HDR.match(nm.strip()))
    holdings=[]; curcat=None
    for i,(name,w) in enumerate(rec):
        low=name.lower()
        if low in ("total","grand total"): continue
        if is_header(name):
            nxt=rec[i+1][0] if i+1<len(rec) else None
            child = nxt is not None and not is_header(nxt) and nxt.lower() not in ("total","grand total")
            if child:
                curcat=name; continue            # section subtotal -> skip
            holdings.append({"security":name,"weightPct":w,"rawCategory":name})  # leaf bucket
            continue
        holdings.append({"security":name,"weightPct":w,"rawCategory":curcat or "EQUITY"})
    return holdings

def parse_profile(pg,header_word,kind,buckets):
    """Capture CREDIT RATING / MATURITY profile: pair % values with bucket labels by x."""
    ws=pg.get_text("words")
    rws=rows(ws)
    # header anchor (the keyword may sit on a different row than "PROFILE")
    hy=hx=None
    for y,g in rws:
        for w in g:
            if w[4]==header_word:
                hx,hy=w[0],y; break
        if hy is not None: break
    if hy is None: return []
    # collect percents and bucket-label anchors within +-45 of header y, near header x
    perc=[]; labs=[]
    for y,g in rws:
        if abs(y-hy)>48: continue
        for w in g:
            if re.match(r"^\d+\.\d+%$",w[4]) and abs(w[0]-hx)<170:
                perc.append((w[0],y,num(w[4])))
    for name,kws in buckets:
        for y,g in rws:
            if abs(y-hy)>48: continue
            txt=[w[4] for w in g]
            for k in range(len(g)-len(kws)+1):
                if tuple(txt[k:k+len(kws)])==kws and abs(g[k][0]-hx)<170:
                    labs.append((g[k][0],y,name)); break
    out=[]; used=set()
    for lx,ly,name in labs:
        cand=[(i,p) for i,p in enumerate(perc) if i not in used]
        if not cand: break
        i,p=min(cand,key=lambda c:abs(c[1][0]-lx))
        used.add(i)
        out.append({"kind":kind,"label":name,"weight":p[2]})
    return out

def parse_managers(pg):
    ws=pg.get_text("words"); rws=rows(ws)
    numrows=[y for y,g in rws if re.search(r"Number of Funds Managed"," ".join(w[4] for w in g))]
    if not numrows: return None,None
    fy=min(numrows)-32          # the name may sit just above the first summary row
    STOP={"NUMBER","OF","FUNDS","MANAGED","EQUITY","DEBT","HYBRID","MONEY","MARKET",
          "INSTRUMENTS","OTHERS","GOVERNMENT","SECURITIES","CORPORATE","CASH","NET",
          "CURRENT","ASSETS","TOTAL","RATING","MATURITY","PROFILE","CREDIT","SECTOR",
          "EXPOSURE","BENCHMARK","HOLDINGS","INDUSTRY","AAA","BONDS"}
    names=[]; summ=[]
    for y,g in rws:                       # one manager name per row (names never wrap)
        if y<fy-3: continue
        txt=" ".join(w[4] for w in g)
        m=re.search(r"Number of Funds Managed.*?Hybrid-\s*\d+",txt)
        if m: summ.append(re.sub(r"\s+"," ",m.group(0)).strip())
        nm=[w[4] for w in sorted(g,key=lambda w:w[0])
            if w[4].isupper() and w[4].isalpha() and len(w[4])>=3 and w[4] not in STOP]
        if nm and len(nm)<=3:
            cand=" ".join(nm).strip()
            if cand and cand not in names: names.append(cand)
    manager=", ".join(names) if names else None
    managed=" | ".join(dict.fromkeys(summ)) if summ else None
    return manager,managed

def parse_page(pg):
    text=pg.get_text()
    ws=pg.get_text("words")
    sfin=None
    for w in ws:
        m=re.search(r"(UL[IGP]F[0-9A-Za-z/]+\d{3})",w[4])
        if m: sfin=m.group(1); break
    if not sfin: return None

    nm=re.search(r"SFIN\s+for\s+(?:the\s+)?(.+?)\s+is\s+(?:SFIN:)?UL[IGP]F",text,re.I|re.S)
    name=re.sub(r"\s+"," ",nm.group(1)).strip() if nm else None
    if not name or len(name)<3:
        name=next((l.strip() for l in text.splitlines() if l.strip()),sfin)
        name=name.title() if name.isupper() else name

    nav=None
    nv=re.search(r"NAV as on[^:]+:\s*Rs\.?\s*([\d,]+\.\d+)",text,re.I)
    if nv: nav=num(nv.group(1))

    inception=None   # date sits on the label's row, immediately right of "INCEPTION"
    DATERE=re.compile(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+((?:19|20)\d{2})",re.I)
    iw=next((w for w in ws if w[4]=="INCEPTION"),None)
    if iw:
        band=sorted([w for w in ws if abs(w[1]-iw[1])<=3 and w[0]>iw[0]],key=lambda w:w[0])
        dm=DATERE.search(" ".join(w[4] for w in band))
        if dm and dm.group(2).lower() in MONTHS:
            d_,mo_,y_=dm.groups()
            inception=f"{y_}-{MONTHS[mo_.lower()]:02d}-{int(d_):02d}"

    benchmark=None
    bm=re.search(r"benchmark is\s+(.+?)(?:Modified Duration|Past performance|This fund|"
                 r"The Benchmark|DATE OF|Fund Performance|\Z)",text,re.I|re.S)
    if not bm: bm=re.search(r"BENCHMARK:\s*(.+?)(?:Fund Performance|\n\n|\Z)",text,re.S)
    if bm:
        b=re.sub(r"\s+"," ",bm.group(1)).strip().rstrip(".")
        if b and b.upper()!="NA" and len(b)<120: benchmark=b

    md=None
    mdm=re.search(r"Modified\s+Duration[^0-9]*?([\d.]+)\s*year",text,re.I)
    if mdm: md=num(mdm.group(1))

    manager,managed=parse_managers(pg)
    alloc,aum=parse_assets(pg)
    alloc=list(alloc)
    alloc+=parse_sectors(pg,text)
    alloc+=parse_profile(pg,"RATING","rating",
            [("AAA & Equivalent",("AAA",)),("AA & Equivalent",("AA",)),("A & Below A",("Below",))])
    # maturity profile now has a native 'maturity' kind in the loader's Zod enum.
    alloc+=parse_profile(pg,"MATURITY","maturity",
            [("Up to 1 year",("Up",)),("Upto 1 year",("Upto",)),
             ("More than 1 year and upto 7 years",("More",)),("Above 7 years",("Above",))])
    returns=parse_returns(pg,text)
    holdings=parse_holdings(pg)

    return {"sfin":sfin,"name":name,"class":"Individual","category":None,
            "nav":nav,"inception":inception,"benchmark":benchmark,"manager":manager,
            "ytm":None,"modifiedDuration":md,"managedSummary":managed,
            "aum":aum,   # Rs. Crore
            "returns":returns,"allocations":alloc,"holdings":holdings}

def main():
    doc=fitz.open(sys.argv[1])
    month=detect_month(doc) or (sys.argv[2] if len(sys.argv)>2 else None)
    funds=[]; seen=set()
    for pg in doc:
        try: f=parse_page(pg)
        except Exception as e:
            sys.stderr.write(f"page {pg.number} error: {e}\n"); continue
        if f and f["sfin"] not in seen:
            seen.add(f["sfin"]); funds.append(f)
    print(json.dumps({"month":month,"funds":funds},indent=2,ensure_ascii=False))

if __name__=="__main__":
    main()
