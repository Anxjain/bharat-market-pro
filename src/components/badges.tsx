// Soft pill badges — the reference's chip language (green/red/gray tints).

import type { Sentiment } from '../data/news'
import type { RiskSeverity } from '../data/risks'
import type { Materiality } from '../data/filings'
import { formatPct } from '../lib/format'

const pill = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold capitalize'

export function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  const styles: Record<Sentiment, string> = {
    positive: 'bg-up-soft text-up',
    negative: 'bg-down-soft text-down',
    neutral: 'bg-panel text-muted',
  }
  // Defensive lookup: a backend value outside the union falls back to neutral instead of
  // rendering an "undefined" class (M-F8).
  return <span className={`${pill} ${styles[sentiment] ?? styles.neutral}`}>{sentiment}</span>
}

export function SeverityBadge({ severity }: { severity: RiskSeverity }) {
  const styles: Record<RiskSeverity, string> = {
    critical: 'bg-down-soft text-down',
    high: 'bg-down-soft text-down',
    medium: 'bg-warn-soft text-[#d28b0e]',
    low: 'bg-accent-soft text-[#3b6fd4]',
  }
  return <span className={`${pill} ${styles[severity] ?? styles.low}`}>{severity}</span>
}

export function MaterialityBadge({ materiality }: { materiality: Materiality }) {
  const styles: Record<Materiality, string> = {
    high: 'bg-down-soft text-down',
    medium: 'bg-warn-soft text-[#d28b0e]',
    low: 'bg-panel text-muted',
  }
  return <span className={`${pill} ${styles[materiality] ?? styles.low}`}>{materiality}</span>
}

export function ExchangeBadge({ exchange }: { exchange: 'NSE' | 'BSE' }) {
  return (
    <span className="rounded-md bg-panel px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-muted">
      {exchange}
    </span>
  )
}

export function ChangePill({ value }: { value: number }) {
  const style =
    value > 0 ? 'bg-up-soft text-up' : value < 0 ? 'bg-down-soft text-down' : 'bg-panel text-muted'
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${style}`}>{formatPct(value)}</span>
}

/** Risk score: rounded track with a mono figure. */
export function RiskScoreBar({ score }: { score: number }) {
  const color = score >= 55 ? '#f6465d' : score >= 40 ? '#f0a30e' : '#2ebd85'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full max-w-[110px] overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="font-mono text-[11px] font-semibold text-muted">{score}</span>
    </div>
  )
}
