// Split a PDF buffer into smaller page-range chunks so a single multimodal
// extraction never exceeds the model's output-token ceiling. Used when a
// whole-document extraction comes back truncated (MAX_TOKENS): we re-extract
// each chunk and merge the funds. A 1-page overlap reduces the chance of a fund
// that straddles a chunk boundary being lost.
import { PDFDocument } from 'pdf-lib'

export async function pageCount(pdf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true })
  return doc.getPageCount()
}

/**
 * Slice `pdf` into chunks of ~`pagesPerChunk` pages (with `overlap` pages of
 * carry-over between consecutive chunks). Returns the chunk PDFs as buffers.
 */
export async function splitPdf(pdf: Buffer, pagesPerChunk = 10, overlap = 1): Promise<Buffer[]> {
  const src = await PDFDocument.load(pdf, { ignoreEncryption: true })
  const total = src.getPageCount()
  if (total <= pagesPerChunk) return [pdf]

  const chunks: Buffer[] = []
  const step = Math.max(1, pagesPerChunk - overlap)
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + pagesPerChunk)
    const out = await PDFDocument.create()
    const idxs = Array.from({ length: end - start }, (_, i) => start + i)
    const copied = await out.copyPages(src, idxs)
    copied.forEach((p) => out.addPage(p))
    chunks.push(Buffer.from(await out.save()))
    if (end >= total) break
  }
  return chunks
}
