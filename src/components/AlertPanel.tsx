// Per-company price alerts: create (above/below a level), list active with
// toggle/delete, and show fired history. Levels render on the chart via the
// parent passing alert prices into TradingChart.

import { useState } from 'react'
import { BellPlus, Bell, BellOff, X, ArrowUp, ArrowDown } from 'lucide-react'
import { useAlerts, createPriceAlert, togglePriceAlert, deletePriceAlert } from '../lib/api'
import { useToast } from '../lib/toast'
import { SectionTitle } from './ui'
import { UP, DOWN } from './TradingChart'

export function AlertPanel({ symbol, lastPrice, onChanged }: { symbol: string; lastPrice: number; onChanged?: () => void }) {
  const { active, history, refresh } = useAlerts(symbol)
  const { toast } = useToast()
  const [condition, setCondition] = useState<'above' | 'below'>('above')
  const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false)

  async function add() {
    const p = Number(price)
    if (!p || p <= 0 || saving) return
    setSaving(true)
    const r = await createPriceAlert(symbol, condition, p)
    if (r.ok) {
      setPrice('')
      toast(`Alert set: ${symbol} ${condition === 'above' ? '≥' : '≤'} ₹${p.toLocaleString('en-IN')}`, 'success')
      refresh()
      onChanged?.()
    } else {
      toast(r.error ?? 'Could not set the alert.')
    }
    setSaving(false)
  }

  return (
    <div className="card p-4">
      <SectionTitle>Price alerts — {symbol}</SectionTitle>

      {/* Create */}
      <form onSubmit={(e) => { e.preventDefault(); add() }} className="flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-full border border-line">
          <button
            type="button"
            onClick={() => setCondition('above')}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[10.5px] font-bold transition-colors ${condition === 'above' ? 'bg-up-soft text-up' : 'bg-surface text-faint'}`}
          >
            <ArrowUp size={11} /> Above
          </button>
          <button
            type="button"
            onClick={() => setCondition('below')}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[10.5px] font-bold transition-colors ${condition === 'below' ? 'bg-down-soft text-down' : 'bg-surface text-faint'}`}
          >
            <ArrowDown size={11} /> Below
          </button>
        </div>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={lastPrice ? `₹ e.g. ${Math.round(lastPrice * (condition === 'above' ? 1.05 : 0.95))}` : '₹ price'}
          inputMode="decimal"
          className="w-28 rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] focus:border-line focus:bg-surface focus:outline-none"
        />
        <button type="submit" disabled={!Number(price) || saving} className="btn btn-red !px-3 !py-1.5 !text-[11px]">
          <BellPlus size={12} /> Set
        </button>
      </form>

      {/* Active */}
      <div className="mt-3 space-y-1">
        {active.length === 0 && <p className="text-[11.5px] italic text-faint">No active alerts — set one above; it's checked against the live price every few minutes.</p>}
        {active.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-panel">
            {a.active ? <Bell size={12} className="text-up" /> : <BellOff size={12} className="text-faint" />}
            <span className="flex-1 text-[12px] font-semibold text-strong">
              {a.condition === 'above' ? '≥' : '≤'} ₹{a.price.toLocaleString('en-IN')}
            </span>
            <button
              onClick={async () => { const r = await togglePriceAlert(a.id, !a.active); if (!r.ok) toast(r.error ?? 'Could not update the alert.'); refresh() }}
              role="switch"
              aria-checked={a.active}
              aria-label={a.active ? 'Pause alert' : 'Resume alert'}
              className={`h-4 w-7 rounded-full p-0.5 transition-colors ${a.active ? 'bg-[#2ebd85]' : 'bg-line'}`}
              title={a.active ? 'Pause' : 'Resume'}
            >
              <span className={`block h-3 w-3 rounded-full bg-surface shadow transition-transform duration-200 ${a.active ? 'translate-x-3' : ''}`} />
            </button>
            <button
              onClick={async () => { const r = await deletePriceAlert(a.id); if (!r.ok) toast(r.error ?? 'Could not delete the alert.'); refresh(); onChanged?.() }}
              className="flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-down-soft hover:text-down"
              title="Delete"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Fired history */}
      {history.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-faint">Recently fired</div>
          {history.slice(0, 4).map((a) => (
            <div key={a.id} className="flex items-baseline gap-2 px-1.5 py-1 text-[11.5px] text-muted">
              <span style={{ color: a.condition === 'above' ? UP : DOWN }}>{a.condition === 'above' ? '▲' : '▼'}</span>
              <span className="flex-1">crossed ₹{a.price.toLocaleString('en-IN')} (hit ₹{a.triggerPrice?.toLocaleString('en-IN')})</span>
              <span className="text-[10px] text-faint">{a.triggeredAt ? new Date(a.triggeredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
