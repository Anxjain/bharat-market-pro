// NSE EOD ingestion - official, free, licensed-for-all archive files:
//   1. NIFTY 500 constituents  -> instruments master
//   2. Daily UDiFF bhavcopy    -> equity OHLCV (prices)
//   3. Daily index close file  -> index OHLC (index_prices)
//
// Run: npm run ingest [-- --days 130]
// Idempotent: upserts by (symbol|name, date); 404 = holiday/weekend -> skip.
// All SQL lives in the repositories (Postgres).

import AdmZip from 'adm-zip'
import { pool } from '../db/client'
import { ensureSchema } from '../db/migrate'
import { setMeta } from '../repositories/meta'
import * as instrumentsRepo from '../repositories/instruments'
import * as pricesRepo from '../repositories/prices'
import * as indexRepo from '../repositories/indexPrices'

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bharat Market Pro/0.1 research prototype' }
const TRACKED_INDICES = ['Nifty 50', 'Nifty Bank', 'Nifty Financial Services', 'Nifty IT', 'Nifty 500', 'India VIX']

function fmt(d: Date, sep = ''): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}${sep}${mm}${sep}${dd}`
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MON: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}
/** Normalize a bhavcopy TradDt (ISO, ISO-datetime, DD-MMM-YYYY, or DD/MM/YYYY)
 *  to YYYY-MM-DD so prices.date sorts correctly and aligns with index_prices.date. */
function normDate(raw: string, fallback: string): string {
  const s = (raw ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/)
  if (m && MON[m[2].toLowerCase()]) return `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return fallback
}

/** Tiny CSV parser (no quoted commas in these NSE files except company names in quotes). */
function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const out: string[] = []
      let cur = ''
      let inQ = false
      for (const ch of line) {
        if (ch === '"') inQ = !inQ
        else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = '' }
        else cur += ch
      }
      out.push(cur.trim())
      return out
    })
}

async function get(url: string): Promise<Response> {
  return fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) })
}

// --- 1. Instruments master (NIFTY 500) ---
export async function ingestUniverse(): Promise<number> {
  const res = await get('https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv')
  if (!res.ok) throw new Error(`nifty500 list HTTP ${res.status}`)
  const rows = parseCsv(await res.text())
  const header = rows[0].map((h) => h.toLowerCase())
  const iName = header.findIndex((h) => h.includes('company'))
  const iInd = header.findIndex((h) => h.includes('industry'))
  const iSym = header.findIndex((h) => h === 'symbol')
  const iIsin = header.findIndex((h) => h.includes('isin'))
  // M-B9: a renamed/removed column yields findIndex === -1 → r[-1] === undefined,
  // silently producing junk rows. Fail loud instead. (ISIN is nullable, so not required.)
  for (const [name, idx] of Object.entries({ symbol: iSym, company: iName, industry: iInd })) {
    if (idx < 0) throw new Error(`nifty500 list: missing required column '${name}' (renamed?) — header: ${rows[0].join(',')}`)
  }

  const out: { symbol: string; name: string; industry: string; isin: string | null }[] = []
  for (const r of rows.slice(1)) {
    if (!r[iSym]) continue
    out.push({ symbol: r[iSym], name: r[iName], industry: r[iInd] || 'Unknown', isin: r[iIsin] ?? null })
  }
  return instrumentsRepo.upsertInstruments(out)
}

// --- 2. Equity bhavcopy (UDiFF) for one day ---
async function ingestBhavcopy(d: Date): Promise<number> {
  const url = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${fmt(d)}_F_0000.csv.zip`
  const res = await get(url)
  if (res.status === 404) return 0 // holiday / weekend / not yet published
  if (!res.ok) throw new Error(`bhavcopy ${fmt(d)} HTTP ${res.status}`)

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()))
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('.csv'))
  if (!entry) return 0
  const rows = parseCsv(entry.getData().toString('utf8'))
  const header = rows[0]
  const col = (name: string) => header.indexOf(name)
  const iSym = col('TckrSymb'), iSrs = col('SctySrs'), iDate = col('TradDt')
  const iO = col('OpnPric'), iH = col('HghPric'), iL = col('LwPric'), iC = col('ClsPric'), iV = col('TtlTradgVol')
  // M-B9: a renamed column would produce NaN prices or a NOT-NULL violation. Fail loud.
  for (const [name, idx] of Object.entries({
    TckrSymb: iSym, SctySrs: iSrs, TradDt: iDate, OpnPric: iO, HghPric: iH, LwPric: iL, ClsPric: iC, TtlTradgVol: iV,
  })) {
    if (idx < 0) throw new Error(`bhavcopy ${fmt(d)}: missing required column '${name}' — header: ${header.join(',')}`)
  }

  const universe = new Set(await instrumentsRepo.listSymbols())
  const out: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = []
  for (const r of rows.slice(1)) {
    if (r[iSrs] !== 'EQ' || !universe.has(r[iSym])) continue
    out.push({
      symbol: r[iSym],
      date: normDate(r[iDate], iso(d)),
      open: Number(r[iO]),
      high: Number(r[iH]),
      low: Number(r[iL]),
      close: Number(r[iC]),
      volume: Number(r[iV]),
    })
  }
  return pricesRepo.upsertPrices(out)
}

// --- 2b. Delivery percentage (sec_bhavdata_full) for one day ---
// Separate NSE archive file; the UDiFF bhavcopy has no delivery data. DELIV_PER is the
// share of traded volume actually delivered (vs intraday churn) — a real-accumulation
// signal at the 3-12 month horizon. Values arrive space-padded; '-' = not applicable.
async function ingestDelivery(d: Date): Promise<number> {
  const ddmmyyyy = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`
  const res = await get(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`)
  if (res.status === 404) return 0 // holiday / not yet published
  if (!res.ok) throw new Error(`delivery ${ddmmyyyy} HTTP ${res.status}`)

  const rows = parseCsv(await res.text())
  const header = rows[0].map((h) => h.trim().toUpperCase())
  const iSym = header.indexOf('SYMBOL')
  const iSrs = header.indexOf('SERIES')
  const iDate = header.indexOf('DATE1')
  const iDeliv = header.indexOf('DELIV_PER')
  if (iSym < 0 || iSrs < 0 || iDeliv < 0) {
    throw new Error(`delivery ${ddmmyyyy}: missing required column — header: ${rows[0].join(',')}`)
  }

  const universe = new Set(await instrumentsRepo.listSymbols())
  const out: { symbol: string; date: string; delivPct: number }[] = []
  for (const r of rows.slice(1)) {
    const sym = r[iSym]?.trim()
    if (r[iSrs]?.trim() !== 'EQ' || !sym || !universe.has(sym)) continue
    const dp = Number(r[iDeliv]?.trim())
    if (!Number.isFinite(dp)) continue
    out.push({ symbol: sym, date: iDate >= 0 ? normDate(r[iDate]?.trim() ?? '', iso(d)) : iso(d), delivPct: dp })
  }
  return pricesRepo.updateDelivery(out)
}

// --- 3. Index closes for one day ---
async function ingestIndexCloses(d: Date): Promise<number> {
  const ddmmyyyy = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`
  const res = await get(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy}.csv`)
  if (res.status === 404) return 0
  if (!res.ok) throw new Error(`index close ${ddmmyyyy} HTTP ${res.status}`)

  const rows = parseCsv(await res.text())
  const header = rows[0].map((h) => h.toLowerCase())
  const iName = header.findIndex((h) => h.includes('index name'))
  const iO = header.findIndex((h) => h.startsWith('open'))
  const iH = header.findIndex((h) => h.startsWith('high'))
  const iL = header.findIndex((h) => h.startsWith('low'))
  const iC = header.findIndex((h) => h.startsWith('closing'))
  // M-B9: fail loud if the index-close layout changed (name/close are required; OHLC nullable).
  for (const [name, idx] of Object.entries({ 'index name': iName, closing: iC })) {
    if (idx < 0) throw new Error(`index close ${ddmmyyyy}: missing required column '${name}' — header: ${rows[0].join(',')}`)
  }

  const num = (s: string) => (s && s !== '-' ? Number(s) : null)
  const out: { name: string; date: string; open: number | null; high: number | null; low: number | null; close: number }[] = []
  for (const r of rows.slice(1)) {
    if (!TRACKED_INDICES.includes(r[iName])) continue
    out.push({ name: r[iName], date: iso(d), open: num(r[iO]), high: num(r[iH]), low: num(r[iL]), close: Number(r[iC]) })
  }
  return indexRepo.upsertIndexPrices(out)
}

// --- Reusable ingest: universe + the last `calendarDays` of EOD prices (open/close
// for every company) + index closes. Idempotent (upserts). Callable from the CLI AND
// the daily scheduler, so prices refresh automatically every day. ---
export async function ingestRecent(calendarDays = 5): Promise<{ sessions: number }> {
  await ensureSchema()
  console.log('[ingest] universe (NIFTY 500)...')
  const uni = await ingestUniverse()
  console.log(`[ingest] instruments upserted: ${uni}`)

  let sessions = 0
  for (let i = 0; i <= calendarDays; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    if (d.getDay() === 0 || d.getDay() === 6) continue // skip weekends
    try {
      const eq = await ingestBhavcopy(d)
      const ix = await ingestIndexCloses(d)
      // Delivery % rides on the same day's price rows; its own failure must never
      // block the price ingest (it's an enrichment, not the record).
      const dl = eq > 0 ? await ingestDelivery(d).catch((e) => { console.warn(`[ingest] delivery ${iso(d)}:`, (e as Error).message); return 0 }) : 0
      if (eq > 0) {
        sessions++
        console.log(`[ingest] ${iso(d)}: ${eq} equities, ${ix} indices, ${dl} delivery rows`)
      }
    } catch (e) {
      console.warn(`[ingest] ${iso(d)} failed:`, (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 350)) // be polite to NSE archives
  }
  await setMeta('lastIngest', new Date().toISOString())
  return { sessions }
}

// --- CLI driver ---
async function main() {
  const daysArg = process.argv.indexOf('--days')
  const calendarDays = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 130
  await ingestRecent(calendarDays)
  const [p, i, n] = await Promise.all([pricesRepo.count(), indexRepo.count(), instrumentsRepo.count()])
  console.log(`[ingest] done - ${n} instruments · ${p} price rows · ${i} index rows`)
}

// Only auto-run when invoked directly (npm run ingest) — NOT when imported by the
// scheduler (otherwise importing it would kick off a full backfill).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('ingest/bhavcopy.ts')) {
  main()
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
