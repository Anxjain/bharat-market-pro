// Tiny label primitive that declares where a surface's data comes from.
// Not a feature — just an honest provenance tag used across pages.

type Variant = 'live' | 'delayed' | 'sample' | 'ai'

const STYLES: Record<Variant, { label: string; cls: string; dot?: boolean }> = {
  live: { label: 'Live · NSE', cls: 'bg-up-soft text-up', dot: true },
  delayed: { label: 'Delayed', cls: 'bg-info-soft text-[#2186c4]' },
  sample: { label: 'Sample · illustrative', cls: 'bg-warn-soft text-[#9a8c63]' },
  ai: { label: 'AI-generated', cls: 'bg-panel text-muted' },
}

export function DataSourceBadge({ variant, label, className = '' }: { variant: Variant; label?: string; className?: string }) {
  const s = STYLES[variant]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${s.cls} ${className}`}>
      {s.dot && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {label ?? s.label}
    </span>
  )
}
