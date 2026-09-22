// Deterministic, offline ULIP extraction — the PRIMARY parse path.
//
// Each insurer's factsheet is parsed by a dedicated coordinate-aware Python script in
// server/extractors/ (PyMuPDF). They read the PDF's real text/vector layer, so the
// output is exact and reproducible: no model, no API key, no quota, no per-run drift.
// The LLM path in extract.ts is now only a fallback for layouts nothing here handles.
//
// Requires python3 + pymupdf on PATH (the Docker image installs both). When Python is
// missing this module reports `unavailable` and extraction falls through to the LLM,
// so a deployment without Python still works exactly as before.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtractionZ, type ExtractedFund } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))
// server/src/ulip -> server/extractors
export const EXTRACTOR_DIR = process.env.ULIP_EXTRACTOR_DIR || join(HERE, '..', '..', 'extractors')

/** adapterId -> extractor script. Every active insurer has one. */
const SCRIPTS: Record<string, string> = {
  hdfc: 'extract_hdfc.py',
  kotak: 'extract_kotak.py',
  sbi: 'extract_sbi.py',
  pnbmetlife: 'extract_pnb.py',
  bhartiaxa: 'extract_bharti.py',
  bandhan: 'extract_bandhan.py',
  canarahsbc: 'extract_canara.py',
  shriram: 'extract_shriram.py',
  tataaia: 'extract_tata.py',
  icicipru: 'extract_icici.py',
}

/** Tata publishes ONE PDF PER FUND, and its extractor globs a directory rather than
 *  taking a single file. Everything else ships one combined PDF per month. */
const DIRECTORY_MODE = new Set(['tataaia'])

export function hasLocalExtractor(adapterId: string): boolean {
  const s = SCRIPTS[adapterId]
  return Boolean(s && existsSync(join(EXTRACTOR_DIR, s)))
}

/** Python interpreter to use. Override with ULIP_PYTHON when the binary isn't `python3`. */
function pythonBin(): string {
  return process.env.ULIP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
}

export interface LocalExtractResult {
  ok: boolean
  funds: ExtractedFund[]
  /** Populated when ok === false, for surfacing in the upload UI / logs. */
  reason?: string
}

/** Run a script and capture stdout. Rejects only on spawn failure; a non-zero exit is
 *  returned so the caller can report the interpreter's own error text. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` })
    }, timeoutMs)
    // Factsheets can hold thousands of holdings — cap the buffer so a runaway script
    // can't grow the heap without bound, but keep it far above any real output (~20MB).
    const LIMIT = 64 * 1024 * 1024
    child.stdout.on('data', (d) => { if (stdout.length < LIMIT) stdout += d.toString() })
    child.stderr.on('data', (d) => { if (stderr.length < 64_000) stderr += d.toString() })
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) } })
  })
}

/** True when a usable Python + PyMuPDF is present. Cached after the first probe. */
let pythonOk: boolean | null = null
export async function localExtractionAvailable(): Promise<boolean> {
  if (pythonOk !== null) return pythonOk
  try {
    const r = await run(pythonBin(), ['-c', 'import fitz'], 20_000)
    pythonOk = r.code === 0
  } catch {
    pythonOk = false
  }
  if (!pythonOk) {
    console.warn('[ulip] deterministic extractor unavailable (needs python3 + pymupdf) — falling back to the LLM path')
  }
  return pythonOk
}

/**
 * Parse an archived factsheet with the insurer's deterministic extractor.
 *
 * @param adapterId insurer adapter id (hdfc, kotak, …)
 * @param rawPath   path to the archived PDF. For per-fund insurers (Tata) the PDF's
 *                  DIRECTORY is passed to the script, so every fund in that month is
 *                  parsed in one call.
 */
export async function extractLocally(adapterId: string, rawPath: string): Promise<LocalExtractResult> {
  const script = SCRIPTS[adapterId]
  if (!script) return { ok: false, funds: [], reason: `no deterministic extractor for "${adapterId}"` }
  const scriptPath = join(EXTRACTOR_DIR, script)
  if (!existsSync(scriptPath)) return { ok: false, funds: [], reason: `extractor script missing: ${scriptPath}` }
  if (!(await localExtractionAvailable())) return { ok: false, funds: [], reason: 'python3 + pymupdf not available' }

  const target = DIRECTORY_MODE.has(adapterId) ? dirname(rawPath) : rawPath

  let out: { code: number; stdout: string; stderr: string }
  try {
    // Big combined sheets (HDFC ~90 funds) take ~30-60s; allow generous headroom.
    out = await run(pythonBin(), [scriptPath, target], 600_000)
  } catch (e) {
    return { ok: false, funds: [], reason: `could not start python: ${(e as Error).message}` }
  }

  const stderrTail = out.stderr.trim().split('\n').slice(-3).join(' | ')
  if (!out.stdout.trim()) {
    return { ok: false, funds: [], reason: `extractor produced no output${stderrTail ? ` (${stderrTail})` : ''}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout)
  } catch {
    return { ok: false, funds: [], reason: `extractor output was not JSON${stderrTail ? ` (${stderrTail})` : ''}` }
  }

  // Scripts emit either {funds:[...]} or {month, funds:[...]} — both satisfy ExtractionZ,
  // which ignores the extra key.
  const val = ExtractionZ.safeParse(parsed)
  if (!val.success) {
    return { ok: false, funds: [], reason: `extractor output failed schema validation: ${val.error.issues[0]?.message ?? 'unknown'}` }
  }
  if (val.data.funds.length === 0) {
    return { ok: false, funds: [], reason: `extractor found no funds in the document${stderrTail ? ` (${stderrTail})` : ''}` }
  }
  return { ok: true, funds: val.data.funds }
}

/** The month the document reports, per the extractor (when it emits one). Used by the
 *  upload flow to label a manually supplied PDF without trusting the uploader. */
export async function detectMonthLocally(adapterId: string, rawPath: string): Promise<string | null> {
  const script = SCRIPTS[adapterId]
  if (!script || !(await localExtractionAvailable())) return null
  const scriptPath = join(EXTRACTOR_DIR, script)
  if (!existsSync(scriptPath)) return null
  const target = DIRECTORY_MODE.has(adapterId) ? dirname(rawPath) : rawPath
  try {
    const out = await run(pythonBin(), [scriptPath, target], 600_000)
    if (!out.stdout.trim()) return null
    const j = JSON.parse(out.stdout) as { month?: unknown }
    return typeof j.month === 'string' && /^\d{4}-\d{2}$/.test(j.month) ? j.month : null
  } catch {
    return null
  }
}
