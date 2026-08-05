import 'server-only'

// Carry a page's query across a CANONICAL REDIRECT. Some of our addresses normalize server-side — an issue
// entered by uuid redirects to `ENG-12`, a cycle entered by uuid redirects to its team's numbered address —
// and the parameter saying what ON that page the visitor came for (`?comment=<id>`, from a mention
// notification) has to survive the hop. A fragment would not: the browser never sends it and `redirect()`
// rebuilds the path, so the anchor is lost. A search parameter survives exactly because the server can see it,
// which is the whole reason the notification link uses one.
export function searchSuffix(entries: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') params.append(key, value)
    else if (Array.isArray(value)) for (const one of value) params.append(key, one)
  }
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}
