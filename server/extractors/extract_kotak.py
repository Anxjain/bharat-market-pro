#!/usr/bin/env python3
"""Kotak Life factsheet -> ExtractionZ JSON (no Gemini). Pure coordinate parsing.

One fund per page (pages with "Date of Inception"). Page 595x842, three columns:
  Left  (x<145) : Date of Inception, AUM (in Lakhs), NAV, Fund Manager(s),
                  Benchmark Details, Modified Duration, Asset Allocation
                  (Approved range + Actual), Performance Meter (returns).
  Middle(160-375): Portfolio "Holdings | % to Fund" -- categorized verbatim
                  (Equity / G-Sec / Corporate Debt / MMI / NCA) with per-category
                  "Others" leaf lines.  Section header lines carry a SUBTOTAL which
                  is skipped (not a holding); leaf categories (MMI/NCA) are kept.
  Right (x>400) : Debt Ratings Profile (%) + an AUM-by-asset bar + Sector
                  Allocation as per NIC 2008 (% to Fund).
Categories are stored VERBATIM, never merged.  AUM printed in LAKHS.
Month auto-detected from "AS ON <DD> <MONTH> <YYYY>".

Usage: PYTHONIOENCODING=utf-8 python extract_kotak.py <pdf>   ({"month","funds":[...]})
"""
import sys, re, json, fitz
from collections import Counter

MONTHS={m:i+1 for i,m in enumerate(
  ["january","february","march","april","may","june","july","august",
   "september","october","november","december"])}
NUM=re.compile(r"^-?\d+\.\d+$")
INT=re.compile(r"^\d+$")
INDNUM=re.compile(r"^\d[\d,]*(?:\.\d+)?$")
SFIN_RE=re.compile(r"\((UL[IGP]F[A-Z0-9/\-]+?\d{3})\)")
RATING=re.compile(r"^(Sovereign|AAA|AA\+|AA-|AA|A1\+|A1|A\+|A-|A|BBB\+|BBB-|BBB|BB\+|BB|B|D|P1\+|Unrated|Cash)$", re.I)
CAT={"equity","g-sec","gsec","corporate debt","mmi","nca"}

def rows(ws,tol=2.5):
    out=[]
    for w in sorted(ws,key=lambda w:(w[1],w[0])):
        if out and abs(w[1]-out[-1][0])<=tol: out[-1][1].append(w)
        else: out.append([w[1],[w]])
    return [(y,sorted(g,key=lambda x:x[0])) for y,g in out]

def num(s):
    try: return float(s.replace(",","").replace("%",""))
    except: return None

def detect_month(doc):
    pat=re.compile(r"AS ON\s+\d+\s*(?:ST|ND|RD|TH)?\s+([A-Za-z]+)\s+(20\d{2})", re.I)
    c=Counter()
    for pg in doc:
        for mo,yr in pat.findall(pg.get_text()):
            if mo.lower() in MONTHS: c[(yr,MONTHS[mo.lower()])]+=1
    if not c: return None
    (yr,mo),_=c.most_common(1)[0]
    return f"{yr}-{mo:02d}"

def parse_inception(text):
    m=re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|"
                r"August|September|October|November|December)\s+(\d{4})", text, re.I)
    if not m: return None
    d,mo,y=m.groups()
    return f"{y}-{MONTHS[mo.lower()]:02d}-{int(d):02d}"

def period_label(label):
    s=label.lower()
    if "inception" in s: return "Inception"
    m=re.match(r"(\d+)\s*(month|year)",s)
    if m: return f"{m.group(1)}{'M' if m.group(2)=='month' else 'Y'}"
    return None

def parse_page(pg):
    text=pg.get_text()
    if "Date of Inception" not in text: return None        # gate: real per-fund page
    sm=SFIN_RE.search(text)
    if not sm: return None
    sfin=sm.group(1).strip().upper()
    words=pg.get_text("words")
    rws=rows(words)

    # ---- SFIN word y + class banner + name (uppercase line(s) just above SFIN) ----
    sfin_y=next((w[1] for w in words if w[4].startswith("(UL")), None)
    banner=" ".join(w[4] for w in words if w[1]<30).upper()
    cls="Group" if "GROUP" in banner and "INDIVIDUAL" not in banner else "Individual"
    name=sfin
    if sfin_y is not None:
        nmw=[w for w in words if sfin_y-26<=w[1]<sfin_y-0.5 and w[0]<420 and w[1]>30
             and re.search(r"[A-Za-z]",w[4])]
        if nmw:
            name=re.sub(r"\s+"," "," ".join(w[4] for w in sorted(nmw,key=lambda w:(round(w[1]),w[0])))).strip().title()

    L=lambda w:w[0]<145                                     # left column
    def left_rows(): return [(y,[w for w in g if L(w)]) for y,g in rws]

    # ---- inception (first month-name date after stripping the AS-ON header) ----
    inception=parse_inception(re.sub(r"AS ON\s+\d+\s*(?:ST|ND|RD|TH)?\s+[A-Za-z]+\s+20\d{2}"," ",text,flags=re.I))

    # ---- AUM total + NAV + Modified Duration (left column, skipping empty rows) ----
    aum_total=nav=md=None
    lrn=[(y,g) for y,g in left_rows() if g]
    for i,(y,g) in enumerate(lrn):
        toks=[w[4] for w in g]
        if "AUM" in toks and any("Lakh" in t for t in toks):
            for (y2,g2) in lrn[i+1:i+4]:
                v=next((w[4] for w in g2 if re.match(r"^\d[\d,]*\.\d{2}$",w[4])),None)
                if v: aum_total=num(v); break
        if "NAV" in toks and nav is None:
            for (y2,g2) in lrn[i+1:i+4]:
                v=next((w[4] for w in g2 if NUM.match(w[4])),None)
                if v: nav=num(v); break
        if any("Instrument" in t for t in toks) and md is None:
            v=next((w[4] for w in g if w[0]>90 and NUM.match(w[4])),None)
            if v is None and i+1<len(lrn):
                v=next((w[4] for w in lrn[i+1][1] if w[0]>90 and NUM.match(w[4])),None)
            if v is not None: md=num(v)

    # ---- managers (left column rows "Equity : <name>" / "Debt : <name>") ----
    eqn=dbn=None
    for y,g in rws:
        lw=[w for w in g if w[0]<145]
        t=[w[4] for w in lw]
        if len(t)>=3 and t[0]=="Equity" and t[1]==":":
            eqn=re.sub(r"\s+"," "," ".join(w[4] for w in lw[2:] if re.match(r"[A-Za-z]",w[4]))).strip()
        if len(t)>=3 and t[0]=="Debt" and t[1]==":":
            dbn=re.sub(r"\s+"," "," ".join(w[4] for w in lw[2:] if re.match(r"[A-Za-z]",w[4]))).strip()
    manager=eqn or dbn or None
    if manager and re.fullmatch(r"N\.?A\.?",manager,re.I): manager=None

    # ---- section y-anchors (left col) ----
    def yof(pred,col=L):
        for y,g in rws:
            if pred(" ".join(w[4] for w in g if col(w))): return y
        return None
    y_asset=yof(lambda t:"Asset Allocation" in t)
    y_perf =yof(lambda t:"Performance Meter" in t)
    y_hold =yof(lambda t:"Holdings" in t and "Fund" in t, col=lambda w:140<w[0]<375)

    # ---- benchmark: value line(s) just below "Benchmark Details" (parens or plain) ----
    benchmark=None
    yb=yof(lambda t:"Benchmark" in t and "Details" in t)
    if yb is not None:
        bw=[w for w in words if w[0]<145 and yb+4<w[1]<yb+34
            and not re.search(r"Modified|Duration|Instrument|Manager|Performance",w[4])]
        line=re.sub(r"\s+"," "," ".join(w[4] for w in sorted(bw,key=lambda w:(round(w[1]),w[0])))).strip()
        # benchmark line carries one component per asset: "Equity - 0% (NA) ; Debt - 100% (Crisil..)"
        parens=[p.strip() for p in re.findall(r"\(([^)]+)\)",line)
                if not re.fullmatch(r"N\.?A\.?",p.strip(),re.I)]
        if parens:
            benchmark=" / ".join(dict.fromkeys(parens))
        elif "(" not in line and line:
            b=re.sub(r"^(Equity|Debt|Balanced|Hybrid)\s*-\s*","",line)
            b=re.sub(r"^100%\s*","",b).strip()
            if b and not re.fullmatch(r"N\.?A\.?",b,re.I): benchmark=b

    # =============== ASSET ALLOCATION (Approved range + Actual) ===============
    alloc=[]
    if y_asset is not None:
        hi=y_perf if y_perf else 1e9
        region=[(y,[w for w in g if L(w)]) for y,g in rws if y_asset<y<hi]
        labelw=[(y,w) for y,g in region for w in g
                if w[0]<58 and re.search(r"[A-Za-z/]",w[4])
                and w[4] not in ("Approved","Actual","Allocation","Asset","(%)")]
        for y,g in region:
            ints=[w for w in g if w[0]>=58 and INT.match(w[4])]
            ints.sort(key=lambda w:w[0])
            dash=any(w[4]=="-" for w in g)
            if dash and len(ints)>=3:
                fmin,fmax,act=num(ints[0][4]),num(ints[1][4]),num(ints[-1][4])
            elif (not dash) and len(ints)==2:          # money market: "100  100"
                fmin=fmax=num(ints[0][4]); act=num(ints[1][4])
            else:
                continue
            lab=[w for ly,w in labelw if abs(ly-y)<=9]
            label=re.sub(r"\s+"," "," ".join(w[4] for w in sorted(lab,key=lambda w:(round(w[1]),w[0])))).strip()
            if not label: continue
            alloc.append({"kind":"asset","label":label,"weight":act,"fuMin":fmin,"fuMax":fmax})

    # =============== RETURNS (Performance Meter, left col) ===============
    returns=[]
    if y_perf is not None:
        for y,g in rws:
            if y<=y_perf: continue
            lab=" ".join(w[4] for w in g if w[0]<58)
            per=period_label(lab)
            if not per: continue
            fl=[(w[0],num(w[4])) for w in g if 60<=w[0]<145 and NUM.match(w[4])]
            if not fl: continue
            fl.sort()
            r=next((v for x,v in fl if x<90),None)
            b=next((v for x,v in fl if x>=90),None)
            returns.append({"period":per,"returnPct":r,"benchmarkPct":b})

    # =============== HOLDINGS (middle column, categorized verbatim) ===============
    holdings=[]
    if y_hold is not None:
        pw=[w for w in words if 158<w[0]<375 and y_hold+2<w[1]<775]
        pcts=[w for w in pw if w[0]>=310 and NUM.match(w[4])]
        names=[w for w in pw if w[0]<310]
        bucket={id(p):[] for p in pcts}
        for nw in names:
            if not pcts: break
            p=min(pcts,key=lambda p:abs(p[1]-nw[1]))
            if abs(p[1]-nw[1])<=11: bucket[id(p)].append(nw)
        holds=[]
        for p in sorted(pcts,key=lambda p:p[1]):
            nm=re.sub(r"\s+"," "," ".join(w[4] for w in sorted(bucket[id(p)],key=lambda w:(round(w[1]),w[0])))).strip()
            holds.append((nm,num(p[4])))
        curcat=None
        for i,(nm,val) in enumerate(holds):
            if not nm or val is None: continue
            low=nm.lower().strip()
            if low=="others":
                holdings.append({"security":"Others","weightPct":val,"rawCategory":curcat or "Equity"}); continue
            if low in CAT:
                has_sec=False
                for (nm2,val2) in holds[i+1:]:
                    l2=nm2.lower().strip()
                    if l2 in CAT: break
                    if l2=="others": continue
                    if nm2: has_sec=True; break
                if has_sec:
                    curcat=nm                                # verbatim section label
                    continue
                holdings.append({"security":nm,"weightPct":val,"rawCategory":nm}); continue
            holdings.append({"security":nm,"weightPct":val,"rawCategory":curcat or "Equity"})

    # =============== DEBT RATINGS PROFILE (right col) ===============
    y_rate=yof(lambda t:"Ratings" in t and "Profile" in t, col=lambda w:w[0]>400)
    y_aumR=None; y_sect=None
    for y,g in rws:
        line=" ".join(w[4] for w in g if w[0]>400)
        if y_aumR is None and "AUM" in line and "Lakh" in line and (y_rate or 0)<y: y_aumR=y
        if y_sect is None and "Sector" in line and "Allocation" in line: y_sect=y
    if y_rate is not None:
        hi=y_aumR if y_aumR else (y_sect or 1e9)
        labs=[(w[1],w[4]) for w in words if 515<=w[0] and y_rate<w[1]<hi and RATING.match(w[4])]
        vals=[(w[1],num(w[4])) for w in words if 405<=w[0]<515 and y_rate<w[1]<hi and NUM.match(w[4])]
        labs.sort(); vals.sort()
        for (ly,lt),(vy,vv) in zip(labs,vals):
            alloc.append({"kind":"rating","label":lt,"weight":vv})

    # AUM: only the factsheet's total is reliable; the right-column split bar is
    # rounded and omits NCA, so it never reconciles to total -- leave parts null.
    aum={"equity":None,"debt":None,"mmi":None,"total":aum_total}

    # =============== SECTOR ALLOCATION (NIC 2008, right col) ===============
    if y_sect is not None:
        snames=[w for w in words if 415<=w[0]<508 and w[1]>y_sect+8 and w[1]<775
                and not NUM.match(w[4]) and "**NIC" not in w[4]]
        svals=[w for w in words if w[0]>=508 and w[1]>y_sect+8 and w[1]<775 and NUM.match(w[4])]
        for vw in svals:
            blk=[w for w in snames if abs(w[1]-vw[1])<=11]
            lab=re.sub(r"\s+"," "," ".join(w[4] for w in sorted(blk,key=lambda w:(round(w[1]),w[0])))).strip()
            lab=re.sub(r"\*+","",lab).strip()
            if lab and len(lab)>2:
                alloc.append({"kind":"sector","label":lab,"weight":num(vw[4])})

    return {"sfin":sfin,"name":name,"class":cls,"category":None,
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
