import { useCallback, useEffect, useRef, useState } from 'react'

// Remember a list screen's filter/search state in localStorage so it survives page navigation.
// SSR-safe: the first render always uses defaults (server/client match) → hydrate from the saved value after mount,
// so there is no hydration mismatch. Writes happen explicitly only inside set/reset (watching values in an effect
// would race and overwrite defaults before hydration).
const PREFIX = 'everdict:filters:'

export type PersistentFilters<T extends Record<string, string>> = {
  values: T
  // Update a single field — persisted to localStorage as the value changes.
  set: <K extends keyof T>(key: K, value: T[K]) => void
  // Reset everything to defaults and clear the saved value.
  reset: () => void
  // Whether any value differs from defaults (drives the reset button's visibility).
  dirty: boolean
}

export function usePersistentFilters<T extends Record<string, string>>(
  // Storage key per screen/workspace (e.g. `harnesses:acme`). Workspace-scoped so another team's filters never leak.
  key: string,
  defaults: T
): PersistentFilters<T> {
  // defaults may be a fresh object each render, so pin the first value in a ref (stable effect deps + immutable dirty baseline).
  const defaultsRef = useRef(defaults)
  const [values, setValues] = useState<T>(defaultsRef.current)

  const storageKey = PREFIX + key

  // Hydrate once on mount — accept only known keys from the saved strings (ignore malformed/stale/foreign data).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return
      const saved = JSON.parse(raw) as Record<string, unknown>
      const next = { ...defaultsRef.current }
      let changed = false
      for (const k of Object.keys(defaultsRef.current) as (keyof T)[]) {
        const v = saved[k as string]
        if (typeof v === 'string' && v !== next[k]) {
          next[k] = v as T[keyof T]
          changed = true
        }
      }
      if (changed) setValues(next)
    } catch {
      // localStorage blocked / JSON corrupt: keep defaults
    }
  }, [storageKey])

  const set = useCallback(
    <K extends keyof T>(k: K, v: T[K]) => {
      setValues((prev) => {
        const next = { ...prev, [k]: v }
        try {
          localStorage.setItem(storageKey, JSON.stringify(next))
        } catch {
          // Ignore a save failure — the in-memory state still works
        }
        return next
      })
    },
    [storageKey]
  )

  const reset = useCallback(() => {
    setValues(defaultsRef.current)
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // ignore
    }
  }, [storageKey])

  const dirty = (Object.keys(defaultsRef.current) as (keyof T)[]).some(
    (k) => values[k] !== defaultsRef.current[k]
  )

  return { values, set, reset, dirty }
}
