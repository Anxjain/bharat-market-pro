// Shared UI primitives — terminal design language.
// White cards, full-round pills, whisper shadows, green/red functional colour.

import type { ReactNode } from 'react'
import { Sparkle } from 'lucide-react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[12.5px] font-bold text-ink">{children}</h2>
      {right}
    </div>
  )
}

/** Analyst note panel — white card with a green spark chip. */
export function AiPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-up-soft text-up">
          <Sparkle size={14} />
        </span>
        <h3 className="text-[14px] font-bold text-ink">{title}</h3>
        <span className="rounded-full bg-panel px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted">
          Desk brief
        </span>
      </div>
      <div className="max-w-3xl text-[13px] leading-[1.75] text-muted">{children}</div>
      <Disclaimer />
    </div>
  )
}

// Disclaimers removed — private personal tool. Kept as a no-op so existing call sites compile.
export function Disclaimer() {
  return null
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl bg-panel px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 text-[14px] font-bold text-ink">{value}</div>
      {sub && <div className="text-[10px] text-faint">{sub}</div>}
    </div>
  )
}

/** Pill-style filter/tab button. */
export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-[11.5px] font-bold capitalize transition-all duration-200 ${
        active
          ? 'border-inkfill bg-inkfill text-white shadow-[0_4px_12px_rgba(22,24,29,0.2)]'
          : 'border-line bg-surface text-muted shadow-sm hover:-translate-y-px hover:text-strong'
      }`}
    >
      {children}
    </button>
  )
}
