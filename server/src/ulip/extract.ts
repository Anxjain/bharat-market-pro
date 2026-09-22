// Extraction seam: send the archived PDF to Gemini (multimodal) and parse a
// strict JSON object keyed by SFIN. The real Gemini path is always tried first;
// when it can't run (no key / no network) we fall back to the deterministic
// fixture for the bundled reference document so the loop is still provable.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { completeWithPdf } from '../llm'
import { ExtractionZ, type ExtractedFund } from './types'
import { fixtureFor } from './fixtures'
import { splitPdf, pageCount } from './pdfsplit'
import { extractLocally } from './extract-local'

const USER_MSG =
  'Extract EVERY fund in this document as JSON per the schema — do not omit any fund, and for each fund include all returns periods, all allocation rows (asset/sector/fnu), and every listed holding.'

/** Parse the model's JSON text into validated funds (with truncation salvage). */
function parseFunds(text: string): ExtractedFund[] {
  const parsed = ExtractionZ.safeParse(parseLoose(text))
  return parsed.success ? parsed.data.funds : []
}

/** "Richness" score — prefer the more complete copy when a fund repeats across chunks. */
function richness(f: ExtractedFund): number {
  return (f.holdings?.length ?? 0) + (f.returns?.length ?? 0) + (f.allocations?.length ?? 0) +
    (f.nav != null ? 1 : 0) + (f.aum?.total != null ? 1 : 0)
}

/** Merge fund lists from multiple chunks, keyed by SFIN, keeping the richest copy. */
function mergeFunds(lists: ExtractedFund[][]): ExtractedFund[] {
  const best = new Map<string, ExtractedFund>()
  for (const list of lists) {
    for (const f of list) {
      const key = (f.sfin || f.name || '').toUpperCase().replace(/[\s-]+/g, '')
      if (!key) continue
      const prev = best.get(key)
      if (!prev || richness(f) > richness(prev)) best.set(key, f)
    }
  }
  return [...best.values()]
}

/**
 * Chunked extraction: split a large factsheet into page-range chunks and extract
 * each separately, then merge. Used when the whole-document call truncated — no
 * single chunk approaches the output ceiling, so the tail funds aren't dropped.
 */
async function extractChunked(adapterId: string, kind: string, pdf: Buffer): Promise<ExtractedFund[]> {
  let chunks: Buffer[]
  try {
    const pages = await pageCount(pdf)
    chunks = await splitPdf(pdf, 10, 1)
    console.log(`[ulip] ${adapterId} ${kind}: whole-doc truncated — chunking ${pages} pages into ${chunks.length} parts`)
  } catch (e) {
    console.warn(`[ulip] ${adapterId} ${kind}: pdf split failed (${(e as Error).message}) — keeping whole-doc result`)
    return []
  }
  const lists: ExtractedFund[][] = []
  for (let i = 0; i < chunks.length; i++) {
    const out = await completeWithPdf(SYSTEM, USER_MSG, chunks[i], { maxTokens: 65536, timeoutMs: 240_000, retries: 3 })
    const funds = out ? parseFunds(out.text) : []
    console.log(`[ulip] ${adapterId} ${kind}: chunk ${i + 1}/${chunks.length} -> ${funds.length} funds${out?.truncated ? ' (still truncated)' : ''}`)
    lists.push(funds)
  }
  return mergeFunds(lists)
}

const SYSTEM = `You extract Indian ULIP fund fact-sheet data from the attached insurer PDF into STRICT JSON.
Return ONLY: {"funds":[{"sfin","name","class","category","nav","inception","benchmark","manager",
"aum":{"equity","debt","mmi","total"},
"returns":[{"period","returnPct","benchmarkPct"}],
"allocations":[{"kind","label","weight","fuMin","fuMax"}],
"holdings":[{"security","weightPct"}]}]}
Rules: one object per fund in the document. "sfin" exactly as printed (spaces removed). "class" is "Individual" or "Pension".
allocations "kind" is one of "asset","sector","fnu" ("fnu" = the Funds & Use mandate band, with fuMin/fuMax the % band and weight the actual %).
All percentages and money are plain numbers (no % or currency symbols). If a field is absent in the document, return null - NEVER guess, NEVER invent or estimate a number.
Keep output compact so every fund fits: list at most the top 20 holdings per fund by weight (factsheets print ~top 10), and do not repeat the same security/period/allocation label twice within a fund. Output JSON only, no prose.`

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return JSON.parse(m[0])
      } catch {
        /* fall through */
      }
    }
    // Last resort: the response was cut off mid-JSON (truncation). Salvage every
    // complete fund object so a partial extraction still yields rows instead of a
    // total fallback to the minimal fixture.
    return salvageTruncated(text)
  }
}

/** Recover funds from a truncated JSON array by parsing each balanced {...} object. */
function salvageTruncated(text: string): unknown {
  const start = text.indexOf('"funds"')
  if (start < 0) return null
  const funds: unknown[] = []
  let depth = 0
  let objStart = -1
  for (let i = text.indexOf('[', start); i >= 0 && i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) {
        try {
          funds.push(JSON.parse(text.slice(objStart, i + 1)))
        } catch {
          /* skip malformed object */
        }
        objStart = -1
      }
    }
  }
  return funds.length ? { funds } : null
}

export interface ExtractResult {
  funds: ExtractedFund[]
  via: 'local' | 'gemini' | 'fixture' | 'none'
  /** Why the deterministic pass didn't produce funds (surfaced by the upload UI). */
  localReason?: string
}

export async function extract(adapterId: string, kind: string, rawPath: string, month: string): Promise<ExtractResult> {
  const pdf = readFileSync(rawPath)

  // Extraction cache: keyed by the PDF's content hash, stored next to the raw file, so
  // re-runs (store/validation fixes, restarts) reuse the parse instead of redoing it.
  // Bypass with ULIP_NO_CACHE=1.
  const hash = createHash('sha256').update(pdf).digest('hex').slice(0, 16)
  const cachePath = `${rawPath}.${hash}.extracted.json`
  if (process.env.ULIP_NO_CACHE !== '1' && existsSync(cachePath)) {
    try {
      const cached = ExtractionZ.safeParse(JSON.parse(readFileSync(cachePath, 'utf8')))
      if (cached.success && cached.data.funds.length > 0) {
        console.log(`[ulip] ${adapterId} ${kind}: extraction cache hit (${cached.data.funds.length} funds)`)
        return { funds: cached.data.funds, via: 'local' }
      }
    } catch {
      /* corrupt cache — fall through and re-extract */
    }
  }

  // ——— PRIMARY: deterministic, offline extraction ———
  // Reads the PDF's own text/vector layer via the insurer's PyMuPDF extractor. Exact,
  // reproducible, free, and unaffected by LLM quota — which is why it runs first.
  // Set ULIP_SKIP_LOCAL=1 to force the LLM path (debugging only).
  let localReason: string | undefined
  if (process.env.ULIP_SKIP_LOCAL !== '1') {
    const local = await extractLocally(adapterId, rawPath)
    if (local.ok) {
      console.log(`[ulip] ${adapterId} ${kind}: deterministic extraction OK (${local.funds.length} funds)`)
      try {
        writeFileSync(cachePath, JSON.stringify({ funds: local.funds }))
      } catch {
        /* cache write is best-effort */
      }
      return { funds: local.funds, via: 'local' }
    }
    localReason = local.reason
    console.warn(`[ulip] ${adapterId} ${kind}: deterministic extraction failed — ${local.reason}`)
  }

  // Real Gemini extraction (multimodal PDF -> JSON). Full factsheets hold 40-50
  // funds; give the model room (65536) so the JSON isn't truncated, and a long
  // timeout because a multi-MB PDF takes ~3 min end-to-end.
  const out = await completeWithPdf(SYSTEM, USER_MSG, pdf, { maxTokens: 65536, timeoutMs: 300_000, retries: 3 })
  if (out) {
    let funds = parseFunds(out.text)
    // If the whole-document output hit the token ceiling, the tail funds were
    // dropped — re-extract in page-chunks and keep whichever yields more funds.
    if (out.truncated) {
      const chunked = await extractChunked(adapterId, kind, pdf)
      if (chunked.length > funds.length) {
        console.log(`[ulip] ${adapterId} ${kind}: chunked extraction recovered ${chunked.length} funds (was ${funds.length})`)
        funds = chunked
      }
    }
    if (funds.length > 0) {
      try {
        writeFileSync(cachePath, JSON.stringify({ funds }))
      } catch {
        /* cache write is best-effort */
      }
      return { funds, via: 'gemini' }
    }
    console.warn(`[ulip] ${adapterId} ${kind}: Gemini returned unparseable/empty JSON`)
  }

  // Offline / unavailable. The deterministic fixture is DEV-ONLY: it stores 1-2 hand-typed
  // stub funds that are indistinguishable from real data, so a forced re-run with a flaky
  // Gemini key would silently replace a full month with stubs. Gate it behind an explicit
  // opt-in; in production (flag unset) store NOTHING and let the doc be retried (H-9).
  if (process.env.ULIP_ALLOW_FIXTURES === '1') {
    return { funds: fixtureFor(adapterId, kind, month), via: 'fixture' }
  }
  console.warn(
    `[ulip] ${adapterId} ${kind}: extraction unavailable and fixtures disabled ` +
      `(set ULIP_ALLOW_FIXTURES=1 for dev) — storing nothing so the month isn't frozen on stub data`,
  )
  return { funds: [], via: 'none', localReason }
}
