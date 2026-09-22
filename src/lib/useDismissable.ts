// Shared dismissable-popover behaviour: Escape to close, outside-click to close,
// and focus return to the trigger on close. Used by every dropdown/menu so the app
// has consistent keyboard + a11y semantics.
import { useEffect, useRef } from 'react'

export interface DismissableOptions {
  /** Close when Escape is pressed (default true). */
  onEscape?: boolean
  /** Close when a pointer-down lands outside the panel (default true). */
  onOutside?: boolean
}

/**
 * Wire Esc + outside-click dismissal for an open popover.
 * Attach `panelRef` to the popover container and `triggerRef` to the button that opens it
 * (focus returns there on close). Both refs are optional but recommended.
 */
export function useDismissable<P extends HTMLElement = HTMLElement, T extends HTMLElement = HTMLElement>(
  open: boolean,
  onClose: () => void,
  opts: DismissableOptions = {},
) {
  const { onEscape = true, onOutside = true } = opts
  const panelRef = useRef<P>(null)
  const triggerRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (onEscape && e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
        triggerRef.current?.focus()
      }
    }
    const handlePointer = (e: PointerEvent) => {
      if (!onOutside) return
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      closeRef.current()
    }
    document.addEventListener('keydown', handleKey, true)
    document.addEventListener('pointerdown', handlePointer, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      document.removeEventListener('pointerdown', handlePointer, true)
    }
  }, [open, onEscape, onOutside])

  return { panelRef, triggerRef }
}
