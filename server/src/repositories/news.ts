// Repository: news (durable store; accumulates beyond the in-memory cache).
import { sql, and, desc, gte } from 'drizzle-orm'
import { db } from '../db/client'
import { news } from '../db/schema'

export interface NewsRow {
  headline: string
  source: string
  publishedAt: string
  sentiment: string
  sentimentScore: number
  summary: string | null
  link: string | null
}

/** Accumulated news for one ticker since `sinceIso` (jsonb tickers @> [symbol]). */
export async function recentForSymbol(symbol: string, sinceIso: string, limit = 14): Promise<NewsRow[]> {
  return db
    .select({ headline: news.headline, source: news.source, publishedAt: news.publishedAt, sentiment: news.sentiment, sentimentScore: news.sentimentScore, summary: news.summary, link: news.link })
    .from(news)
    .where(and(sql`${news.tickers} @> ${JSON.stringify([symbol.toUpperCase()])}::jsonb`, gte(news.publishedAt, sinceIso)))
    .orderBy(desc(news.publishedAt))
    .limit(limit)
}

/** Distinct tickers with ANY stored news since `sinceIso` — one query for a whole
 *  alert-rules pass (9.7 `noNews` condition) instead of a per-symbol probe. */
export async function tickersWithNewsSince(sinceIso: string): Promise<string[]> {
  const rows = await db.select({ tickers: news.tickers }).from(news).where(gte(news.publishedAt, sinceIso))
  return [...new Set(rows.flatMap((r) => r.tickers))]
}

export interface NewsInsert {
  dedupKey: string
  headline: string
  source: string
  publishedAt: string
  tickers: string[]
  sentiment: string
  sentimentScore: number
  tier: string
  summary: string | null
  link: string | null
  firstSeenAt: string
}

/** Upsert by dedupKey; existing rows are left untouched so first-seen time stays stable. */
export async function upsertMany(items: NewsInsert[]): Promise<number> {
  if (items.length === 0) return 0
  await db.insert(news).values(items).onConflictDoNothing({ target: news.dedupKey })
  return items.length
}

export async function count(): Promise<number> {
  const rows = await db.select({ n: sql<number>`cast(count(*) as int)` }).from(news)
  return rows[0]?.n ?? 0
}

/** M-B4: prune news older than `days` (publishedAt is ISO text → lexicographic compare
 *  is chronological). Parameterized cutoff; returns rows removed. */
export async function pruneOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const res = await db.delete(news).where(sql`${news.publishedAt} < ${cutoff}`)
  return (res as unknown as { rowCount?: number | null }).rowCount ?? 0
}
