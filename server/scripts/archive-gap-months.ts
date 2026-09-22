// Archive-only backfill for "gap months" — insurer-months whose FUND DATA exists (parsed
// during the local backfill) but whose source PDF was never archived on this machine, so
// the fund page's "source factsheet" link falls back to a live webpage instead of the
// exact deep-linked document.
//
// For each gap this re-fetches the official monthly PDF via the adapter's own discovery
// (month-aware listing scrape / direct URL template, Chromium where the site needs it),
// archives it under RAW_DIR, and marks the sources row 'stored' so the link resolver
// serves it. The pipeline's as-on month guard (H-7) still applies — a wrong-month
// document is refused, and that month honestly stays on the live-page fallback.
//
// Does NOT touch fund data. Safe to re-run (archive() is idempotent).
// After a successful run, wire the deep links: npm run ulip:source-pages
//
// Run: npx tsx scripts/archive-gap-months.ts [adapterId]
import '../src/load-env'
import { ADAPTERS } from '../src/ulip/adapters'
import { archive } from '../src/ulip/archive'
import * as sourcesRepo from '../src/repositories/sources'
import { pool } from '../src/db/client'

/** Fund months with no stored source PDF (audited 2026-07-06 on the live DB).
 *  Shriram 2026-05 is EXCLUDED: the insurer only hosts the current month's factsheet
 *  (May's CDN object is gone; April's still exists) — that month honestly stays on the
 *  live-page fallback. */
const GAPS: Record<string, string[]> = {
  kotak: ['2025-12', '2026-01', '2026-02'],
  pnbmetlife: ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04'],
  shriram: ['2026-06'],
  bhartiaxa: ['2026-01', '2026-02', '2026-03', '2026-04'],
  canarahsbc: ['2026-05'],
  bandhan: ['2026-01', '2026-02', '2026-03', '2026-04'],
}

/**
 * Hand-pinned document URLs where the adapter's listing discovery can't find archive
 * months (Bharti's listing month-matcher picks wrong-year compilations for past months;
 * Bandhan's Chromium listing render doesn't reach the older rows). Each URL was verified
 * in a real browser on 2026-07-06 to be the insurer's official monthly factsheet — and
 * the as-on month guard in archive() still validates the document's internal date.
 */
const URL_OVERRIDES: Record<string, Record<string, string>> = {
  bandhan: {
    '2026-01': 'https://www.bandhanlife.com/sites/default/files/asset/2026-01/Bandhan%20Life_InDepth%20JAN%202026.pdf',
    '2026-02': 'https://www.bandhanlife.com/sites/default/files/asset/2026-02/Bandhan%20Life%20InDepth%20Feb%202026.pdf',
    '2026-03': 'https://www.bandhanlife.com/sites/default/files/asset/2026-03/Bandhan%20Life%20InDepth%20March-2026.pdf',
    '2026-04': 'https://www.bandhanlife.com/sites/default/files/asset/2026-04/Bandhan-Life-InDepth-April-2026.pdf',
  },
  bhartiaxa: {
    '2026-01': 'https://www.bhartiaxa.com/sites/default/files/newsletter_factsheet/monthly/2025-26/newsletter-fund-factsheet-jan-2026.pdf',
    '2026-02': 'https://www.bhartiaxa.com/sites/default/files/newsletter_factsheet/monthly/2025-26/newsletter-fund-factsheet-feb-2026.pdf',
    '2026-03': 'https://www.bhartiaxa.com/sites/default/files/newsletter_factsheet/monthly/2025-26/newsletter-march-2026.pdf',
    '2026-04': 'https://www.bhartiaxa.com/sites/default/files/newsletter_factsheet/monthly/2026-27/newsletter-and-fund-factsheet-april-2026.pdf',
  },
}

async function main() {
  const only = process.argv[2]
  let ok = 0
  let gap = 0
  for (const [id, months] of Object.entries(GAPS)) {
    if (only && id !== only) continue
    const adapter = ADAPTERS[id]
    if (!adapter) { console.warn(`[gaps] unknown adapter ${id}`); continue }
    for (const month of months) {
      // With a pinned URL, bypass listing discovery entirely (discovery 'direct' + the
      // exact doc URL); plain fetch suffices for a static PDF asset.
      const override = URL_OVERRIDES[id]?.[month]
      const effective = override
        ? { ...adapter, discovery: 'direct' as const, scrapeListing: undefined, fetchMode: 'plain' as const }
        : adapter
      for (const doc of adapter.docs(month)) {
        const effectiveDoc = override ? { ...doc, url: override } : doc
        try {
          const a = await archive(effective, month, effectiveDoc)
          if (!a) { gap++; continue }
          // The funds for this month were already parsed (that's why it's a gap, not a
          // missing month) — mark the row servable so the link resolver streams the PDF.
          await sourcesRepo.setParseStatus(adapter.irdaiCode, month, doc.kind, 'stored')
          ok++
          console.log(`[gaps] ${id} ${month}: archived + stored (${a.via}, sha ${a.sha256.slice(0, 12)})`)
        } catch (e) {
          gap++
          console.warn(`[gaps] ${id} ${month}: failed — ${(e as Error).message}`)
        }
      }
    }
  }
  console.log(`[gaps] done — ${ok} archived, ${gap} still gapped`)
  await pool.end()
}
main()
