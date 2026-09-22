// Production candlestick chart — TradingView Lightweight Charts (the engine
// behind Upstox/Groww-class charting):
//   native wheel-zoom, drag-pan, magnetic crosshair with OHLCV legend,
//   plus REAL drawing tools layered on top:
//     · price levels (click → horizontal line, native priceLine)
//     · trend lines (two clicks → vector overlay, tracks zoom/pan)
//     · text notes (click → annotation pinned to time/price)
//   Drawings persist per symbol (localStorage). Alert levels render as
//   amber dashed lines so alerts are visible in context.

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine, type Time, type MouseEventParams,
} from 'lightweight-charts'
import {
  MousePointer2, Minus, PenLine, Type, Trash2, Maximize2, ZoomIn, ZoomOut, Eye, EyeOff,
} from 'lucide-react'
import type { Candle } from '../data/series'
import { useTheme } from '../lib/theme'

export const UP = '#2ebd85'
export const DOWN = '#f6465d'

/** lightweight-charts colours per theme (the chart bg is transparent → inherits the card). */
function chartColors(dark: boolean) {
  return {
    text: dark ? '#9aa1ac' : '#9ca1aa',
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(22,24,29,0.05)',
    crosshair: dark ? '#7d838d' : '#9ca1aa',
    crosshairLabel: dark ? '#3a3f4a' : '#16181d',
    volume: dark ? 'rgba(255,255,255,0.10)' : '#e7e9ed',
  }
}

type Tool = 'select' | 'hline' | 'trend' | 'text'

interface Anchor { time: string; price: number }
interface Drawing {
  id: string
  type: 'hline' | 'trend' | 'text'
  price?: number
  p1?: Anchor
  p2?: Anchor
  text?: string
}

function storageKey(symbol: string) {
  return `ig.drawings.${symbol}`
}

export function TradingChart({ data, symbol, height = 420, fill = false, levels = [] }: {
  data: Candle[]
  symbol: string
  /** Fixed pixel height (ignored when `fill` is set). */
  height?: number
  /** Fill the parent flex container — resizes live, never recreates the chart. */
  fill?: boolean
  levels?: { price: number; title: string }[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const smaRef = useRef<ISeriesApi<'Line'> | null>(null)
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map())
  const levelLinesRef = useRef<IPriceLine[]>([])
  const drawingsRef = useRef<Drawing[]>([])
  const pendingRef = useRef<Anchor | null>(null)
  const toolRef = useRef<Tool>('select')

  const { theme } = useTheme()
  const dark = theme === 'dark'

  const [tool, setToolState] = useState<Tool>('select')
  const [showSma, setShowSma] = useState(true)
  const [trendPending, setTrendPending] = useState(false) // render-safe mirror of pendingRef
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number; date: string } | null>(null)

  const setTool = (t: Tool) => {
    toolRef.current = t
    pendingRef.current = null
    setTrendPending(false)
    setToolState(t)
  }

  // ——— overlay rendering (trend lines, text notes, pending anchor) ———
  const redrawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const chart = chartRef.current
    const series = candleRef.current
    if (!canvas || !chart || !series) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const toXY = (a: Anchor): { x: number; y: number } | null => {
      const x = chart.timeScale().timeToCoordinate(a.time as Time)
      const y = series.priceToCoordinate(a.price)
      return x == null || y == null ? null : { x, y }
    }

    for (const d of drawingsRef.current) {
      if (d.type === 'trend' && d.p1 && d.p2) {
        const a = toXY(d.p1)
        const b = toXY(d.p2)
        if (!a || !b) continue
        ctx.strokeStyle = '#6366f1'
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        for (const p of [a, b]) {
          ctx.fillStyle = '#6366f1'
          ctx.beginPath()
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      if (d.type === 'text' && d.p1 && d.text) {
        const a = toXY(d.p1)
        if (!a) continue
        ctx.font = '600 11px "DM Sans", sans-serif'
        const tw = ctx.measureText(d.text).width
        ctx.fillStyle = 'rgba(22,24,29,0.92)'
        ctx.beginPath()
        ctx.roundRect(a.x - 4, a.y - 22, tw + 12, 18, 5)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.fillText(d.text, a.x + 2, a.y - 9)
      }
    }
    if (pendingRef.current) {
      const a = toXY(pendingRef.current)
      if (a) {
        ctx.fillStyle = '#6366f1'
        ctx.beginPath()
        ctx.arc(a.x, a.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [])

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey(symbol), JSON.stringify(drawingsRef.current))
    } catch { /* storage full — non-fatal */ }
  }, [symbol])

  const addHline = useCallback((d: Drawing) => {
    const series = candleRef.current
    if (!series || d.price == null) return
    const line = series.createPriceLine({
      price: d.price,
      color: '#6366f1',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'level',
    })
    priceLinesRef.current.set(d.id, line)
  }, [])

  // ——— chart construction (ONCE — resizes via ResizeObserver, never recreated) ———
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const c = chartColors(dark)
    const chart = createChart(el, {
      height: el.clientHeight || height,
      layout: { background: { color: 'transparent' }, textColor: c.text, fontFamily: '"DM Sans", sans-serif', fontSize: 11 },
      grid: { horzLines: { color: c.grid }, vertLines: { color: 'transparent' } },
      crosshair: {
        vertLine: { color: c.crosshair, style: LineStyle.Dashed, labelBackgroundColor: c.crosshairLabel },
        horzLine: { color: c.crosshair, style: LineStyle.Dashed, labelBackgroundColor: c.crosshairLabel },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 4 },
    })
    chartRef.current = chart

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    })
    candleRef.current = candle

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: c.volume,
      priceLineVisible: false, lastValueVisible: false,
    })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })
    volRef.current = vol

    const sma = chart.addSeries(LineSeries, {
      color: '#7aa7f7', lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    })
    smaRef.current = sma

    // crosshair → OHLCV legend
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const d = param.seriesData.get(candle) as { open: number; high: number; low: number; close: number } | undefined
      const v = param.seriesData.get(vol) as { value: number } | undefined
      if (d && param.time) {
        setLegend({ o: d.open, h: d.high, l: d.low, c: d.close, v: v?.value ?? 0, date: String(param.time) })
      } else {
        setLegend(null)
      }
      redrawOverlay()
    })

    // click → drawing tools
    chart.subscribeClick((param: MouseEventParams) => {
      const t = toolRef.current
      if (t === 'select' || !param.point || !param.time) return
      const price = candle.coordinateToPrice(param.point.y)
      if (price == null) return
      const anchor: Anchor = { time: String(param.time), price: Math.round(price * 100) / 100 }

      if (t === 'hline') {
        const d: Drawing = { id: `d${Date.now()}`, type: 'hline', price: anchor.price }
        drawingsRef.current.push(d)
        addHline(d)
        persist()
        setTool('select')
      } else if (t === 'trend') {
        if (!pendingRef.current) {
          pendingRef.current = anchor
          setTrendPending(true)
        } else {
          drawingsRef.current.push({ id: `d${Date.now()}`, type: 'trend', p1: pendingRef.current, p2: anchor })
          pendingRef.current = null
          persist()
          setTool('select')
        }
        redrawOverlay()
      } else if (t === 'text') {
        const text = window.prompt('Note text:')
        if (text?.trim()) {
          drawingsRef.current.push({ id: `d${Date.now()}`, type: 'text', p1: anchor, text: text.trim().slice(0, 40) })
          persist()
        }
        setTool('select')
        redrawOverlay()
      }
    })

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => redrawOverlay())

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
      redrawOverlay()
    })
    ro.observe(el)

    const priceLines = priceLinesRef.current
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      priceLines.clear()
      levelLinesRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ——— data + saved drawings per symbol ———
  useEffect(() => {
    const candle = candleRef.current
    const vol = volRef.current
    const sma = smaRef.current
    const chart = chartRef.current
    if (!candle || !vol || !sma || !chart || data.length === 0) return

    candle.setData(data.map((c) => ({ time: c.date as Time, open: c.o, high: c.h, low: c.l, close: c.c })))
    vol.setData(data.map((c) => ({ time: c.date as Time, value: c.v, color: c.c >= c.o ? 'rgba(46,189,133,0.28)' : 'rgba(246,70,93,0.28)' })))
    sma.setData(data.filter((c) => c.sma != null).map((c) => ({ time: c.date as Time, value: c.sma as number })))
    chart.timeScale().fitContent()

    // restore saved drawings for this symbol
    for (const line of priceLinesRef.current.values()) candle.removePriceLine(line)
    priceLinesRef.current.clear()
    try {
      drawingsRef.current = JSON.parse(localStorage.getItem(storageKey(symbol)) ?? '[]') as Drawing[]
    } catch {
      drawingsRef.current = []
    }
    for (const d of drawingsRef.current) if (d.type === 'hline') addHline(d)
    requestAnimationFrame(redrawOverlay)
  }, [data, symbol, addHline, redrawOverlay])

  // ——— alert levels (amber dashed) ———
  // Key the effect on a stable serialization so a caller passing an inline
  // (non-memoized) levels array can't force the lines to rebuild every render.
  const levelsKey = JSON.stringify(levels)
  useEffect(() => {
    const candle = candleRef.current
    if (!candle) return
    for (const l of levelLinesRef.current) candle.removePriceLine(l)
    levelLinesRef.current = levels.map((lv) =>
      candle.createPriceLine({
        price: lv.price, color: '#f0a30e', lineWidth: 1, lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: true, title: lv.title,
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- levelsKey is the stable proxy for `levels`; `data` triggers a re-attach after a series reset
  }, [levelsKey, data])

  // SMA toggle
  useEffect(() => {
    smaRef.current?.applyOptions({ visible: showSma })
  }, [showSma])

  // Re-theme the chart when light/dark flips (the chart is created once).
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const c = chartColors(dark)
    chart.applyOptions({
      layout: { textColor: c.text },
      grid: { horzLines: { color: c.grid }, vertLines: { color: 'transparent' } },
      crosshair: {
        vertLine: { color: c.crosshair, labelBackgroundColor: c.crosshairLabel },
        horzLine: { color: c.crosshair, labelBackgroundColor: c.crosshairLabel },
      },
    })
    volRef.current?.applyOptions({ color: c.volume })
  }, [dark])

  function clearDrawings() {
    const candle = candleRef.current
    drawingsRef.current = []
    if (candle) for (const line of priceLinesRef.current.values()) candle.removePriceLine(line)
    priceLinesRef.current.clear()
    persist()
    redrawOverlay()
  }

  function zoom(factor: number) {
    const ts = chartRef.current?.timeScale()
    const range = ts?.getVisibleLogicalRange()
    if (!ts || !range) return
    const center = (range.from + range.to) / 2
    const half = ((range.to - range.from) / 2) * factor
    ts.setVisibleLogicalRange({ from: center - half, to: center + half })
  }

  const last = data[data.length - 1]
  const shown = legend ?? (last ? { o: last.o, h: last.h, l: last.l, c: last.c, v: last.v, date: last.date } : null)

  const tools: { key: Tool | 'clear' | 'fit' | 'zin' | 'zout'; icon: typeof MousePointer2; label: string }[] = [
    { key: 'select', icon: MousePointer2, label: 'Select / pan' },
    { key: 'hline', icon: Minus, label: 'Price level (click chart)' },
    { key: 'trend', icon: PenLine, label: 'Trend line (two clicks)' },
    { key: 'text', icon: Type, label: 'Note (click chart)' },
    { key: 'zin', icon: ZoomIn, label: 'Zoom in' },
    { key: 'zout', icon: ZoomOut, label: 'Zoom out' },
    { key: 'fit', icon: Maximize2, label: 'Fit all' },
    { key: 'clear', icon: Trash2, label: 'Clear drawings' },
  ]

  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col' : ''}>
      {/* Legend + SMA toggle */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-1.5">
        <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[10.5px] font-bold text-strong shadow-sm">{symbol}</span>
        {shown && (
          <span className="flex items-center gap-2.5 font-mono text-[10.5px] text-muted">
            <span>{shown.date}</span>
            <span>O <b className="text-strong">{shown.o.toLocaleString('en-IN')}</b></span>
            <span>H <b className="text-strong">{shown.h.toLocaleString('en-IN')}</b></span>
            <span>L <b className="text-strong">{shown.l.toLocaleString('en-IN')}</b></span>
            <span>C <b style={{ color: shown.c >= shown.o ? UP : DOWN }}>{shown.c.toLocaleString('en-IN')}</b></span>
            {shown.v > 0 && <span>V <b className="text-strong">{(shown.v / 1e6).toFixed(2)}M</b></span>}
          </span>
        )}
        <button
          onClick={() => setShowSma((s) => !s)}
          className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${showSma ? 'bg-accent-soft text-[#3b6fd4]' : 'bg-panel text-faint'}`}
        >
          {showSma ? <Eye size={10} /> : <EyeOff size={10} />} SMA 20
        </button>
      </div>

      {/* Chart + drawing overlay */}
      <div className={fill ? 'relative min-h-0 flex-1' : 'relative'} style={fill ? undefined : { height }}>
        <div ref={containerRef} className="absolute inset-0" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        {tool !== 'select' && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-inkfill px-3 py-1 text-[10.5px] font-semibold text-white shadow-lg">
            {tool === 'hline' ? 'Click the chart to place a price level' : tool === 'trend' ? (trendPending ? 'Click the second point' : 'Click the first point of the trend line') : 'Click where the note should go'}
          </div>
        )}
      </div>

      {/* Tool dock */}
      <div className="mt-1.5 flex items-center justify-center gap-1">
        {tools.map((t) => {
          const active = t.key === tool
          return (
            <button
              key={t.key}
              title={t.label}
              onClick={() => {
                if (t.key === 'clear') clearDrawings()
                else if (t.key === 'fit') chartRef.current?.timeScale().fitContent()
                else if (t.key === 'zin') zoom(0.6)
                else if (t.key === 'zout') zoom(1.6)
                else setTool(t.key as Tool)
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 ${
                active ? 'bg-inkfill text-white shadow-md' : 'text-muted hover:bg-panel'
              }`}
            >
              <t.icon size={14.5} />
            </button>
          )
        })}
        <span className="ml-2 text-[10px] text-faint">scroll = zoom · drag = pan</span>
      </div>
    </div>
  )
}
