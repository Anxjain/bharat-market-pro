// Recent developments — the qualitative side of the desk. Pulls real corporate
// FILINGS (with the AI one-line summary we already compute) and tagged NEWS for a
// symbol, classifies each as supportive / concerning / neutral with a direction, and
// hands the strongest ones to the readout so they appear in plain English in the
// verdict ("Won an order on 12 Jun → supports demand"), not just as a count.
import * as guidanceFilingsRepo from '../repositories/guidanceFilings'
import * as newsRepo from '../repositories/news'
import { getInstrument } from '../repositories/instruments'
import { companyNews, corporateActions } from '../company-feed'

export type DevTone = 'supportive' | 'concerning' | 'neutral'
export interface Development {
  date: string // YYYY-MM-DD
  kind: 'filing' | 'news'
  category: string // filing category, or news source
  title: string
  summary: string | null // AI digest (filings) / RSS summary (news)
  materiality: string | null
  tone: DevTone
  link: string | null
}
export interface Developments {
  filings: Development[]
  news: Development[]
  positives: Development[] // strongest supportive (surfaced in reasons)
  negatives: Development[] // strongest concerning
}

const POS = /\border|contract|awarded?|\bwins?\b|bags?|secures?|buy ?back|bonus|record (profit|revenue|order)|expansion|commission|new (plant|project|order|capacity)|capacity addition|approval|acquisition|stake (acqui|increase)|interim dividend|upgrade|highest ever|strong (results|growth)/i
const NEG = /\bqip\b|preferential|rights issue|fund ?rais|dilut|resign|auditor|fraud|default|insolvency|\bnclt\b|penalty|\bfine\b|downgrade|investigation|litigation|impair|\bloss\b|profit (fall|decline|drop)|\bcut\b|warn|pledge|encumbr|lock-?out|strike|recall|show cause|tax demand/i

function classify(text: string, sentiment?: number): DevTone {
  if (NEG.test(text)) return 'concerning'
  if (POS.test(text)) return 'supportive'
  if (sentiment != null) return sentiment > 0.2 ? 'supportive' : sentiment < -0.3 ? 'concerning' : 'neutral'
  return 'neutral'
}

/** Strip NSE filing boilerplate so a raw title reads like a headline. */
function cleanTitle(s: string): string {
  return s
    .replace(/^[A-Z][\w&.\- ]+?(Limited|Ltd\.?|Corporation|Corp\.?|Company)\s+has informed the Exchange\s+(about|regarding|that)?\s*/i, '')
    .replace(/\(Sub-?para[^)]*\)/gi, '')
    .replace(/\|?\s*SUBJECT:\s*/i, ' — ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[—-]\s*$/, '')
    .trim()
}

/** Drop near-duplicate developments (NSE often files the same thing twice). */
function dedupe(list: Development[]): Development[] {
  const seen = new Set<string>()
  const out: Development[] = []
  for (const d of list) {
    const key = `${d.date}|${(d.summary || d.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

export async function getDevelopments(symbol: string): Promise<Developments> {
  const sym = symbol.toUpperCase()
  const now = Date.now()
  const since120 = new Date(now - 120 * 864e5).toISOString()
  const inst = await getInstrument(sym).catch(() => null)

  // ——— Exchange filings for THIS symbol, last ~6 months ———
  // H-11: a symbol-scoped, time-windowed query — not a filter over the newest 800 rows
  // market-wide (which spanned only a few days, so the "6 months" window was fictional and
  // could silently miss a name's dilution / auditor flag).
  const since180 = new Date(now - 180 * 864e5).toISOString()
  const symFilings = await guidanceFilingsRepo.forSymbolSince(sym, since180).catch(() => [])
  let filings: Development[] = symFilings
    .map((f) => ({
      date: f.filedAt.slice(0, 10),
      kind: 'filing' as const,
      category: f.category,
      title: cleanTitle(f.title).slice(0, 160),
      summary: f.summary ? f.summary.replace(/\s+/g, ' ').trim() : null,
      materiality: f.materiality,
      tone: classify(`${f.category} ${f.title} ${f.summary ?? ''}`),
      link: f.link,
    }))

  // ——— Corporate actions (Yahoo dividends/splits), last year ———
  try {
    const cas = await corporateActions(sym, [])
    const caDev: Development[] = cas
      .filter((a) => now - Date.parse(a.date) < 365 * 864e5)
      .slice(0, 6)
      .map((a) => ({
        date: a.date,
        kind: 'filing' as const,
        category: a.type,
        title: a.detail,
        summary: null,
        materiality: null,
        tone: (/dividend|bonus|buy ?back/i.test(`${a.type} ${a.detail}`) ? 'supportive' : 'neutral') as DevTone,
        link: a.link ?? null,
      }))
    filings = [...filings, ...caDev]
  } catch {
    /* corporate actions optional */
  }
  filings = dedupe(filings).slice(0, 14)

  // ——— Per-company news (Google News, 1y) — the live fetch is rich; it's also PERSISTED
  // inside companyNews() so it accumulates and the DB can serve it if a later fetch fails. ———
  let news: Development[] = []
  if (inst?.name) {
    const fresh = await companyNews(inst.name, sym).catch(() => []) // returns items + persists them
    news = dedupe(
      fresh
        .filter((n) => now - Date.parse(n.publishedAt) < 120 * 864e5)
        .map((n) => ({
          date: n.publishedAt.slice(0, 10),
          kind: 'news' as const,
          category: n.source,
          title: n.headline,
          summary: null,
          materiality: null,
          tone: classify(n.headline, n.sentimentScore),
          link: n.link ?? null,
        })),
    ).slice(0, 10)
    // Reliability fallback: if the live fetch came back empty, serve accumulated history.
    if (news.length === 0) {
      const rows = await newsRepo.recentForSymbol(sym, since120, 14).catch(() => [])
      news = dedupe(
        rows.map((n) => ({ date: n.publishedAt.slice(0, 10), kind: 'news' as const, category: n.source, title: n.headline, summary: n.summary, materiality: null, tone: classify(`${n.headline} ${n.summary ?? ''}`, n.sentimentScore), link: n.link })),
      ).slice(0, 10)
    }
  }

  // Strongest signals for the reasons: high-materiality filings first, then news.
  const rank = (d: Development) => (d.materiality === 'high' ? 3 : d.materiality === 'medium' ? 2 : d.kind === 'news' ? 1 : 0)
  const all = [...filings, ...news]
  const positives = all.filter((d) => d.tone === 'supportive').sort((a, b) => rank(b) - rank(a)).slice(0, 4)
  const negatives = all.filter((d) => d.tone === 'concerning').sort((a, b) => rank(b) - rank(a)).slice(0, 4)
  return { filings, news, positives, negatives }
}
