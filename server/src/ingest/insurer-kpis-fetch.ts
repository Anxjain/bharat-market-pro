// Phase 2 — AUTOMATED quarterly insurer-KPI refresh. Fetches each listed insurer's
// investor-presentation PDF, extracts the KPIs with Gemini, validates them against
// sanity ranges, and upserts — but the CURATED table is the floor: a field is only
// overwritten when the extraction is high-confidence AND in range, so a flaky parse
// can never replace a good sourced number with garbage.
//
// Discovery mirrors the ULIP pipeline: a configured presentation URL per insurer, with
// a manual intake fallback (drop a PDF at intake/insurer-kpis/<SYMBOL>.pdf) for the
// bot-gated IR sites (e.g. HDFC Life 403s plain fetchers).
//
// Run: `npm run ingest:insurer-kpis [SYMBOL]`  (all insurers, or one). Also scheduled.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { completeWithPdf } from '../llm'
import * as repo from '../repositories/insurerKpis'
import { BROWSER_UA } from '../util/shared'

interface KpiSource {
  symbol: string
  type: 'Life' | 'General' | 'Health'
  /** Direct investor-presentation PDF URL (best-effort; update per quarter/IR change). */
  pdfUrl?: string
  irPage: string // human reference / source link fallback
}

// Per-insurer sources. URLs are best-effort and expected to need maintenance like the
// ULIP adapters; when one 403s or moves, drop the quarter's PDF into intake/insurer-kpis/.
const SOURCES: KpiSource[] = [
  { symbol: 'LICI', type: 'Life', irPage: 'https://licindia.in/web/guest/press-release' },
  { symbol: 'SBILIFE', type: 'Life', irPage: 'https://www.sbilife.co.in/en/about-us/investor-relations' },
  { symbol: 'HDFCLIFE', type: 'Life', irPage: 'https://www.hdfclife.com/about-us/investor-relations' },
  { symbol: 'ICICIGI', type: 'General', irPage: 'https://www.icicilombard.com/investor-relations' },
  { symbol: 'STARHEALTH', type: 'Health', irPage: 'https://www.starhealth.in/investor-relations' },
]

interface ExtractedKpi {
  period: string | null
  vnbMarginPct: number | null
  solvencyRatio: number | null
  persistency13mPct: number | null
  combinedRatioPct: number | null
  apeGrowthPct: number | null
  embeddedValueCr: number | null
  marketSharePct: number | null
  confidence: 'high' | 'medium' | 'low'
}

// Sanity ranges — a value outside its band is treated as a misread and dropped.
const RANGES: Record<string, [number, number]> = {
  vnbMarginPct: [3, 45],
  solvencyRatio: [1.3, 4],
  persistency13mPct: [45, 96],
  combinedRatioPct: [75, 135],
  apeGrowthPct: [-60, 120],
  embeddedValueCr: [500, 2_000_000],
  marketSharePct: [0, 70],
}

const inRange = (k: string, v: number | null): v is number =>
  v != null && Number.isFinite(v) && v >= RANGES[k][0] && v <= RANGES[k][1]

const SYSTEM =
  'You extract a small set of headline KPIs from an Indian insurer\'s quarterly/annual ' +
  'investor presentation or results release. Return STRICT JSON only, no prose. Use null ' +
  'for any metric not clearly stated. Do NOT guess or infer. Report percentages as numbers ' +
  '(e.g. 21.2 for 21.2%), solvency as the ratio (e.g. 2.35 for 235%), embedded value in ₹ crore.'

const USER =
  'Extract these fields as JSON: {"period": "e.g. FY26 or Q4 FY26", "vnbMarginPct", ' +
  '"solvencyRatio", "persistency13mPct", "combinedRatioPct", "apeGrowthPct" (YoY APE or ' +
  'GDPI/GWP growth %), "embeddedValueCr" (Indian Embedded Value, ₹ crore), "marketSharePct", ' +
  '"confidence": "high"|"medium"|"low"}. For a general/health insurer, vnbMargin/persistency/EV ' +
  'are usually null. Only return a number you can read directly from the document.'

async function loadPdf(src: KpiSource): Promise<{ buf: Buffer; url: string } | null> {
  // 1) manual intake drop wins (bot-gated IR sites).
  const intake = join(process.cwd(), 'intake', 'insurer-kpis', `${src.symbol}.pdf`)
  if (existsSync(intake)) return { buf: await readFile(intake), url: src.irPage }
  // 2) configured direct PDF URL.
  if (src.pdfUrl) {
    try {
      const res = await fetch(src.pdfUrl, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(30_000) })
      if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), url: src.pdfUrl }
      console.warn(`[insurer-kpis] ${src.symbol}: pdfUrl HTTP ${res.status}`)
    } catch (e) {
      console.warn(`[insurer-kpis] ${src.symbol}: fetch failed ${(e as Error).message}`)
    }
  }
  return null
}

/** Refresh one insurer; returns true if the row was updated with fresh figures. */
export async function refreshInsurer(src: KpiSource): Promise<boolean> {
  const pdf = await loadPdf(src)
  if (!pdf) { console.log(`[insurer-kpis] ${src.symbol}: no PDF (configure pdfUrl or drop intake/insurer-kpis/${src.symbol}.pdf) — keeping curated`); return false }

  const res = await completeWithPdf(SYSTEM, USER, pdf.buf, { maxTokens: 2048 })
  if (!res?.text) { console.warn(`[insurer-kpis] ${src.symbol}: extraction returned nothing — keeping curated`); return false }

  let ext: ExtractedKpi
  try {
    ext = JSON.parse(res.text.replace(/^```json\s*|\s*```$/g, '')) as ExtractedKpi
  } catch { console.warn(`[insurer-kpis] ${src.symbol}: unparseable JSON — keeping curated`); return false }

  if (ext.confidence === 'low') { console.warn(`[insurer-kpis] ${src.symbol}: low confidence — keeping curated`); return false }

  // Start from the existing curated row (the floor) and overlay only in-range fields.
  const existing = (await repo.list()).find((r) => r.symbol === src.symbol)
  const merged: repo.InsurerKpiRow = {
    symbol: src.symbol,
    type: src.type,
    vnbMarginPct: inRange('vnbMarginPct', ext.vnbMarginPct) ? ext.vnbMarginPct : existing?.vnbMarginPct ?? null,
    solvencyRatio: inRange('solvencyRatio', ext.solvencyRatio) ? ext.solvencyRatio : existing?.solvencyRatio ?? null,
    persistency13mPct: inRange('persistency13mPct', ext.persistency13mPct) ? ext.persistency13mPct : existing?.persistency13mPct ?? null,
    combinedRatioPct: inRange('combinedRatioPct', ext.combinedRatioPct) ? ext.combinedRatioPct : existing?.combinedRatioPct ?? null,
    apeGrowthPct: inRange('apeGrowthPct', ext.apeGrowthPct) ? ext.apeGrowthPct : existing?.apeGrowthPct ?? null,
    embeddedValueCr: inRange('embeddedValueCr', ext.embeddedValueCr) ? ext.embeddedValueCr : existing?.embeddedValueCr ?? null,
    marketSharePct: inRange('marketSharePct', ext.marketSharePct) ? ext.marketSharePct : existing?.marketSharePct ?? null,
    period: ext.period ?? existing?.period ?? 'unknown',
    sourceUrl: pdf.url,
    updatedAt: new Date().toISOString(),
  }
  await repo.upsertMany([merged])
  console.log(`[insurer-kpis] ${src.symbol}: updated (period ${merged.period}, confidence ${ext.confidence})`)
  return true
}

/** Refresh all insurers (or one by symbol). Logs, never throws. */
export async function refreshInsurerKpis(only?: string): Promise<number> {
  const targets = only ? SOURCES.filter((s) => s.symbol === only.toUpperCase()) : SOURCES
  let updated = 0
  for (const src of targets) {
    try { if (await refreshInsurer(src)) updated++ } catch (e) { console.warn(`[insurer-kpis] ${src.symbol} failed: ${(e as Error).message}`) }
  }
  console.log(`[insurer-kpis] done — ${updated}/${targets.length} updated from PDFs (rest kept curated)`)
  return updated
}

// CLI: `tsx src/ingest/insurer-kpis-fetch.ts [SYMBOL]`
if (process.argv[1]?.endsWith('insurer-kpis-fetch.ts')) {
  import('../load-env').then(async () => {
    const { pool } = await import('../db/client')
    await refreshInsurerKpis(process.argv[2])
    await pool.end()
  })
}
