// Small chart pieces: sparklines (cards/rails) and the sentiment stack bar.
// Heavy candlestick charting lives in TradingChart.tsx.

import type { PricePoint } from '../data/series'
import { UP, DOWN } from './TradingChart'

// Inline SVG sparkline (no recharts) — keeps the heavy charting lib out of the entry
// bundle; the only recharts usage left is the lazy-loaded ULIP Trends charts.
export function Sparkline({ data, positive }: { data: PricePoint[]; positive: boolean }) {
  const color = positive ? UP : DOWN
  const W = 100
  const H = 40
  if (!data || data.length < 2) return <svg width="100%" height={H} aria-hidden />
  const prices = data.map((d) => d.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const stepX = W / (data.length - 1)
  const pts = prices
    .map((p, i) => `${(i * stepX).toFixed(2)},${(H - 2 - ((p - min) / span) * (H - 4)).toFixed(2)}`)
    .join(' ')
  const fillId = `spark-${positive ? 'up' : 'down'}`
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${fillId})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

const SENTIMENT_COLORS = { positive: UP, neutral: '#d8dbe0', negative: DOWN }

/** Flat stacked bar + counts for sentiment mixes. */
export function SentimentBar({ positive, neutral, negative }: { positive: number; neutral: number; negative: number }) {
  const total = positive + neutral + negative || 1
  const rows = [
    { label: 'Positive', value: positive, color: SENTIMENT_COLORS.positive },
    { label: 'Neutral', value: neutral, color: SENTIMENT_COLORS.neutral },
    { label: 'Negative', value: negative, color: SENTIMENT_COLORS.negative },
  ]
  return (
    <div>
      <div className="flex h-[6px] w-full overflow-hidden rounded-full">
        {rows.map((r) => (
          <div key={r.label} style={{ width: `${(r.value / total) * 100}%`, background: r.color }} />
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between text-[12px]">
            <span className="flex items-baseline gap-2 text-muted">
              <span className="text-[8px]" style={{ color: r.color }}>■</span>
              {r.label}
            </span>
            <span className="font-mono font-medium text-strong">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
