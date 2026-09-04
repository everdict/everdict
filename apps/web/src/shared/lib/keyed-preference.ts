// The storage layer for a user preference remembered ONE PER SCREEN — it holds values that differ **per list** ("how do I draw this list")
// in a single cookie. It exists so the issue list's display settings and the evaluation lists' use the same machinery.
//
// The container is URLSearchParams for two reasons: it escapes the `:` inside a view key by itself, and it gives ONE answer — **the last one**
// — for a corrupted cookie where the same key is written twice (a preference with two answers is not a preference).
//
// It is a cookie rather than localStorage because it has to be: a list's first screen is drawn by a server component, so this value has to be
// known BEFORE drawing. localStorage cannot be read at that point, so the chosen view arrives as a flicker.

export function decodeKeyedPreference(cookie: string | undefined): Map<string, string> {
  const entries = new Map<string, string>()
  if (cookie === undefined || cookie === '') return entries
  for (const [key, value] of new URLSearchParams(cookie)) entries.set(key, value)
  return entries
}

export function encodeKeyedPreference(entries: Map<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) params.append(key, value)
  return params.toString()
}

// Write one screen's choice. The point is that the CHANGED screen moves to the front — a cookie rides on every request so it cannot grow
// without bound, and past the cap the **least recently touched** screen has to be the one pushed out (not an arbitrary one).
// A pushed-out screen simply returns to its defaults the next time it is opened.
export function withKeyedPreference(
  cookie: string | undefined,
  key: string,
  value: string,
  max: number
): string {
  const existing = decodeKeyedPreference(cookie)
  existing.delete(key)
  const next = new Map<string, string>([[key, value]])
  for (const [otherKey, otherValue] of existing) {
    if (next.size >= max) break
    next.set(otherKey, otherValue)
  }
  return encodeKeyedPreference(next)
}

// Read and written straight from the browser. A preference cookie is not httpOnly and is not DATA, so there is no reason to make a server-action
// round trip for it — and that round trip was one piece of "why does changing the grouping take so long".
// A cookie used for authentication or authorization NEVER uses this door (those are the server's alone).
const PREFERENCE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export function readPreferenceCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (decodeURIComponent(part.slice(0, eq)) !== name) continue
    return decodeURIComponent(part.slice(eq + 1))
  }
  return undefined
}

export function writePreferenceCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${PREFERENCE_MAX_AGE_SECONDS}; samesite=lax`
}
