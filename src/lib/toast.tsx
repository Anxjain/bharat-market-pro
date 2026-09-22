// Minimal toast system — a provider + a useToast() hook. Surfaces mutation failures
// (and successes) that were previously swallowed silently. No dependency, no portal:
// a fixed stack rendered at the app root.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'error' | 'success' | 'info'
export interface Toast { id: number; kind: ToastKind; message: string }

interface ToastCtx {
  toasts: Toast[]
  toast: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

const Ctx = createContext<ToastCtx>({ toasts: [], toast: () => {}, dismiss: () => {} })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])

  const toast = useCallback((message: string, kind: ToastKind = 'error') => {
    const id = nextId.current++
    setToasts((ts) => [...ts, { id, kind, message }])
    // Auto-dismiss after a few seconds (errors linger a touch longer).
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 4000)
  }, [])

  const value = useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss])

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  )
}

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12.5px] shadow-[0_12px_32px_rgba(16,24,40,0.16)] ${
            t.kind === 'error'
              ? 'border-down-soft bg-down-soft text-down'
              : t.kind === 'success'
                ? 'border-up-soft bg-up-soft text-up'
                : 'border-line bg-surface text-strong'
          }`}
        >
          <span className="flex-1 leading-snug">{t.message}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="shrink-0 text-current opacity-60 transition-opacity hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook + provider share this module
export function useToast() {
  return useContext(Ctx)
}
