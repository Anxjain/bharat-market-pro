// Shared formatting helpers (Indian numbering conventions).

export function formatINR(value: number, decimals = 2): string {
  return '₹' + value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Format ₹ crore values: 2222000 -> "₹22.22 L Cr", 36000 -> "₹36,000 Cr" */
export function formatCrore(cr: number): string {
  if (cr >= 100000) return `₹${(cr / 100000).toFixed(2)} L Cr`
  return `₹${cr.toLocaleString('en-IN')} Cr`
}

export function formatPct(value: number, signed = true): string {
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function changeColor(value: number): string {
  if (value > 0) return 'text-emerald-700'
  if (value < 0) return 'text-red-600'
  return 'text-muted'
}

export function timeAgo(iso: string, now = new Date()): string {
  const then = new Date(iso)
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
