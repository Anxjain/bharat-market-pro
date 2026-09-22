// Admin-only: upload a monthly factsheet PDF and have it parsed, validated and stored.
//
// This exists because automated fetching is the fragile part of the pipeline — insurers
// move URLs without notice and some sit behind a WAF that blocks a server outright, so a
// month can silently go missing. Handing the PDF over directly always works, and it runs
// the same extract -> validate -> store path, so an uploaded month is not second-class.
//
// The panel never asks the operator which insurer or month it is. Both are read out of
// the document and shown for confirmation; the selectors exist only to override a
// document the server could not read, and an override that contradicts the PDF has to be
// confirmed explicitly.
import { useCallback, useMemo, useRef, useState } from 'react'
import { Upload, RefreshCw, CheckCircle2, AlertTriangle, FileText } from 'lucide-react'
import {
  identifyFactsheet, uploadFactsheet, reExtractMonth,
  type UlipAdminStatus, type UlipIdentity, type UlipUploadResult,
} from '../../lib/ulip'

/** Months to offer as a manual override: the last 24, newest first. */
function recentMonths(): string[] {
  const out: string[] = []
  const d = new Date()
  d.setUTCDate(1)
  for (let i = 0; i < 24; i++) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
    d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return out
}

export function FactsheetUpload({ status, onIngested }: { status: UlipAdminStatus; onIngested?: () => void }) {
  const insurers = useMemo(() => status.insurers ?? [], [status.insurers])
  const [file, setFile] = useState<File | null>(null)
  const [ident, setIdent] = useState<UlipIdentity | null>(null)
  const [identError, setIdentError] = useState<string | null>(null)
  const [insurer, setInsurer] = useState('')
  const [month, setMonth] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState<'identify' | 'upload' | 'reextract' | null>(null)
  const [result, setResult] = useState<UlipUploadResult | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const pick = useCallback(async (f: File) => {
    setFile(f)
    setResult(null)
    setIdent(null)
    setIdentError(null)
    setForce(false)
    setBusy('identify')
    const r = await identifyFactsheet(f)
    setBusy(null)
    if ('error' in r) { setIdentError(r.error); return }
    setIdent(r)
    // Pre-fill the selectors with whatever the document declared, so the operator only
    // has to intervene when detection came up empty.
    setInsurer(r.insurerId ?? '')
    setMonth(r.month ?? '')
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void pick(f)
  }, [pick])

  const submit = useCallback(async () => {
    if (!file) return
    setBusy('upload')
    setResult(null)
    const r = await uploadFactsheet(file, {
      insurer: insurer || undefined,
      month: month || undefined,
      force,
    })
    setBusy(null)
    setResult(r)
    if (r.ok) {
      setFile(null)
      setIdent(null)
      setForce(false)
      if (inputRef.current) inputRef.current.value = ''
      onIngested?.()
    }
  }, [file, insurer, month, force, onIngested])

  const rerun = useCallback(async () => {
    if (!insurer || !month) return
    setBusy('reextract')
    setResult(null)
    const code = insurers.find((i) => i.id === insurer)?.code ?? insurer
    const r = await reExtractMonth(code, month)
    setBusy(null)
    setResult(r)
    if (r.ok) onIngested?.()
  }, [insurer, month, insurers, onIngested])

  // A selection that contradicts the document is the one mistake that would corrupt data
  // permanently, so surface it before the operator commits rather than after.
  const conflict =
    ident && ((ident.insurerId && insurer && ident.insurerId !== insurer) ||
              (ident.month && month && ident.month !== month))

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-strong">Upload a factsheet</h3>
          <p className="mt-0.5 text-[11.5px] text-faint">
            Drop an insurer&rsquo;s monthly PDF here. The insurer and reporting month are read from the
            document itself, then every fund, portfolio holding and classification is extracted and stored.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${
            status.deterministicExtractor ? 'bg-up-soft text-up' : 'bg-warn-soft text-[#c4762a]'
          }`}
          title={
            status.deterministicExtractor
              ? 'Parsing runs fully offline — no AI model, no API key, no quota.'
              : 'Python/PyMuPDF was not found, so parsing will fall back to the optional AI extractor.'
          }
        >
          {status.deterministicExtractor ? 'Offline extractor ready' : 'Offline extractor unavailable'}
        </span>
      </header>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`mt-3 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? 'border-strong bg-accent-soft' : 'border-line hover:border-strong'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f) }}
        />
        {file ? (
          <span className="flex items-center gap-2 text-[12.5px] text-strong">
            <FileText size={14} /> {file.name}
            <span className="tabular-nums text-faint">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
          </span>
        ) : (
          <>
            <Upload size={18} className="text-faint" />
            <span className="mt-1.5 text-[12.5px] text-strong">Drop a PDF, or click to choose</span>
            <span className="mt-0.5 text-[11px] text-faint">One combined monthly factsheet, or a single per-fund sheet</span>
          </>
        )}
      </div>

      {busy === 'identify' && <p className="mt-2 text-[11.5px] italic text-faint">Reading the document&hellip;</p>}
      {identError && <p className="mt-2 text-[11.5px] text-down">{identError}</p>}

      {/* What the document says about itself */}
      {ident && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Detected from the document</p>
          <p className="mt-1 text-[12.5px] text-strong">
            {ident.insurerName ?? <span className="text-down">insurer not recognised</span>}
            {' · '}
            {ident.month ?? <span className="text-down">month not recognised</span>}
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {ident.evidence.map((e, i) => (
              <li key={i} className="text-[11px] text-faint">— {e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Overrides — only needed when detection failed or is wrong */}
      {file && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-faint">Insurer</span>
            <select
              value={insurer}
              onChange={(e) => setInsurer(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-strong"
            >
              <option value="">— detect from document —</option>
              {insurers.map((i) => (
                <option key={i.id} value={i.id}>{i.name}{i.hasExtractor ? '' : ' (no offline extractor)'}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-faint">Month</span>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-strong"
            >
              <option value="">— detect from document —</option>
              {recentMonths().map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={busy !== null}
            className="rounded-lg bg-inkfill px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-40"
          >
            {busy === 'upload' ? 'Extracting…' : 'Upload & extract'}
          </button>

          {insurer && month && (
            <button
              type="button"
              onClick={rerun}
              disabled={busy !== null}
              title="Re-parse the PDF already archived for this insurer and month — no upload needed."
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-strong disabled:opacity-50"
            >
              <RefreshCw size={12} className={busy === 'reextract' ? 'animate-spin' : ''} />
              Re-extract stored
            </button>
          )}
        </div>
      )}

      {conflict && (
        <label className="mt-2.5 flex items-start gap-2 rounded-lg border border-warn-soft-bd bg-warn-soft p-2.5">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-0.5" />
          <span className="text-[11.5px] text-strong">
            Your selection disagrees with what the document says
            {ident?.insurerName ? ` (${ident.insurerName}` : ''}{ident?.month ? `, ${ident.month})` : ident?.insurerName ? ')' : ''}.
            Storing it anyway files this data under the wrong insurer or month — tick to confirm you mean it.
          </span>
        </label>
      )}

      {busy === 'upload' && (
        <p className="mt-2.5 text-[11.5px] italic text-faint">
          Extracting every fund, holding and classification. A full combined factsheet takes a minute or two.
        </p>
      )}

      {result && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border p-3 ${
            result.ok ? 'border-up-soft-bd bg-up-soft' : 'border-down-soft-bd bg-down-soft'
          }`}
        >
          {result.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-up" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-down" />}
          <div>
            <p className="text-[12.5px] text-strong">{result.message}</p>
            {result.ok && (
              <p className="mt-1 text-[11px] tabular-nums text-faint">
                {result.stored} funds · {result.holdings} holdings · {result.byStatus.clean} clean
                {result.byStatus.suspicious > 0 && ` · ${result.byStatus.suspicious} flagged for review`}
                {result.replaced && ' · replaced the previously stored month'}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
