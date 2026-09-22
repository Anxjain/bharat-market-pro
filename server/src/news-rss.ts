// LIVE news adapter: aggregates Indian business press RSS feeds and maps them
// onto the frontend's NewsItem contract (same shape as src/data/news.ts).
// This is the first REAL data source in Bharat Market Pro.
//
// Pipeline: fetch feeds (parallel, fault-tolerant) -> dedupe -> tag tickers by
// company-name aliases -> rule-based sentiment -> sort by time -> cache 10 min ->
// persist into the durable `news` store (Postgres) so headlines accumulate.
// Phase 2: swap the rule sentiment for a model-based classification pass.

import type { NewsItem, Sentiment } from '../../src/data/news'
import { listSymbolName } from './repositories/instruments'
import * as newsRepo from './repositories/news'
import { hashId, wordRe, makeRssParser } from './util/shared'

const FEEDS: { source: string; url: string }[] = [
  // Markets desks
  { source: 'Economic Times', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { source: 'Economic Times', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { source: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  { source: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/buzzingstocks.xml' },
  { source: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/MCtopnews.xml' },
  { source: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/business.xml' },
  { source: 'Mint', url: 'https://www.livemint.com/rss/markets' },
  { source: 'Business Standard', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { source: 'BusinessLine', url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss' },
  { source: 'CNBC-TV18', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml' },
  { source: 'NDTV Profit', url: 'https://feeds.feedburner.com/ndtvprofit-latest' },
  // Note: Business Standard /companies, Zee Business and Financial Express block
  // automated fetches (403/HTML) - revisit via a news API (Marketaux) at scale.
]


const POSITIVE = ['surge', 'rally', 'record', 'beats', 'beat', 'wins', 'win', 'jumps', 'jump', 'soars', 'gains', 'gain', 'upgrade', 'strong', 'profit rises', 'highest', 'growth', 'bullish', 'buyback', 'expansion', 'approves', 'launch']
const NEGATIVE = ['falls', 'fall', 'drops', 'drop', 'slump', 'plunge', 'loss', 'losses', 'probe', 'penalty', 'fraud', 'downgrade', 'weak', 'misses', 'miss', 'concern', 'fears', 'cuts', 'cut', 'layoff', 'recall', 'default', 'bearish', 'crash']

// Precompile the static sentiment lexicons once.
const POS_RE = POSITIVE.map(wordRe)
const NEG_RE = NEGATIVE.map(wordRe)

// --- Ticker tagging over the FULL instruments universe (rebuilt periodically) ---
interface Alias { symbol: string; res: RegExp[] }
let aliasCache: { aliases: Alias[]; at: number } | null = null
const ALIAS_TTL_MS = 30 * 60 * 1000

// Single-word short names this generic are too ambiguous to tag on (kills
// false positives like "life" -> LICI on an unrelated headline).
const GENERIC_SHORT = new Set([
  'life', 'india', 'power', 'energy', 'finance', 'bank', 'motor', 'motors', 'steel', 'auto',
  'oil', 'gas', 'tech', 'infra', 'cement', 'sugar', 'paper', 'textiles', 'chemicals', 'tata',
  'corporation', 'holdings', 'products', 'enterprises', 'services', 'state', 'national', 'general',
])

async function buildAliases(): Promise<Alias[]> {
  const rows = await listSymbolName()
  return rows.map((r) => {
    const needles = new Set<string>()
    const sym = r.symbol.toLowerCase()
    if (sym.length >= 3) needles.add(sym)
    const name = r.name.toLowerCase()
    if (name.length >= 3) needles.add(name) // full name = exact, precise
    // short name: drop generic corporate suffixes so "Reliance Industries Ltd" -> "reliance"
    const short = name
      .replace(/\b(ltd\.?|limited|industries|corporation of india|corp\.?|insurance|bank|finance|financial|services|enterprises|india)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    // Multi-word short names are distinctive; single words must be >=5 chars and not generic.
    const words = short.split(' ').filter(Boolean)
    if (short.length >= 4 && (words.length >= 2 || (short.length >= 5 && !GENERIC_SHORT.has(short)))) {
      needles.add(short)
    }
    return { symbol: r.symbol, res: [...needles].map(wordRe) }
  })
}

async function getAliases(): Promise<Alias[]> {
  if (!aliasCache || Date.now() - aliasCache.at > ALIAS_TTL_MS) {
    aliasCache = { aliases: await buildAliases(), at: Date.now() }
  }
  return aliasCache.aliases
}

export function scoreSentiment(text: string): { sentiment: Sentiment; score: number } {
  let score = 0
  for (const re of POS_RE) if (re.test(text)) score += 0.25
  for (const re of NEG_RE) if (re.test(text)) score -= 0.25
  score = Math.max(-1, Math.min(1, score))
  const sentiment: Sentiment = score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral'
  return { sentiment, score: Math.round(score * 100) / 100 }
}

async function tagTickers(text: string): Promise<string[]> {
  const hits = new Set<string>()
  for (const a of await getAliases()) {
    if (a.res.some((re) => re.test(text))) hits.add(a.symbol)
  }
  return [...hits]
}

/** Decode the HTML entities that commonly survive RSS parsing. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

const parser = makeRssParser(10_000, false)

let cache: { items: NewsItem[]; fetchedAt: number } | null = null
const CACHE_MS = 5 * 60 * 1000 // near-realtime: refreshed every 5 min (+ background warmer)

/** Persist the freshly built press items into the durable news store (best-effort). */
async function persist(items: NewsItem[]): Promise<void> {
  if (items.length === 0) return
  const now = new Date().toISOString()
  try {
    await newsRepo.upsertMany(
      items.map((n) => ({
        dedupKey: n.id,
        headline: n.headline,
        source: n.source,
        publishedAt: n.publishedAt,
        tickers: n.tickers,
        sentiment: n.sentiment,
        sentimentScore: n.sentimentScore,
        tier: n.tier ?? 'press',
        summary: n.summary ?? null,
        link: n.link ?? null,
        firstSeenAt: now,
      })),
    )
  } catch (e) {
    console.warn('[news] persist failed:', (e as Error).message)
  }
}

export async function fetchLiveNews(): Promise<{ items: NewsItem[]; sources: string[]; fetchedAt: string }> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) {
    return { items: cache.items, sources: [...new Set(FEEDS.map((f) => f.source))], fetchedAt: new Date(cache.fetchedAt).toISOString() }
  }

  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const feed = await parser.parseURL(f.url)
      return (feed.items ?? []).map((item) => ({ feedSource: f.source, item }))
    }),
  )

  const seen = new Set<string>()
  const items: NewsItem[] = []
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const { feedSource, item } of r.value) {
      const headline = decodeEntities((item.title ?? '').trim())
      if (!headline || seen.has(headline)) continue
      seen.add(headline)
      const summaryRaw = decodeEntities(
        (item.contentSnippet ?? item.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      )
      const text = `${headline} ${summaryRaw}`
      const { sentiment, score } = scoreSentiment(text)
      items.push({
        id: `live-${hashId(headline)}`,
        headline,
        source: feedSource,
        publishedAt: item.isoDate ?? new Date().toISOString(),
        tickers: await tagTickers(text),
        sentiment,
        sentimentScore: score,
        summary: summaryRaw.slice(0, 280) || headline,
        tier: 'press',
        link: (item.link ?? '').trim() || undefined,
      })
    }
  }

  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const top = items.slice(0, 90)
  if (top.length > 0) {
    cache = { items: top, fetchedAt: Date.now() }
    await persist(top)
  }
  return { items: top, sources: [...new Set(FEEDS.map((f) => f.source))], fetchedAt: new Date().toISOString() }
}
