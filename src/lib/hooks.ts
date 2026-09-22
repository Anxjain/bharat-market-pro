// Small shared hooks.
import { useEffect, useState } from 'react'

/** Returns `value` delayed by `delay` ms — settles only after the user stops typing. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
