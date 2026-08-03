// Image-reference string rules for display ("host[:port]/ns/name:tag@sha256:…"). The web is runtime-decoupled
// (type-only `@everdict/contracts`), so it cannot call `@everdict/domain`'s parser — these are the same rules,
// display-side. One owner for the whole app.

// Split a ref into its parts. The tag is the ':' AFTER the last '/' (the earlier one is a "host:port" port).
function splitImageRef(ref: string): { repository: string; tag?: string; digest?: string } {
  const at = ref.indexOf('@')
  const base = at >= 0 ? ref.slice(0, at) : ref
  const digest = at >= 0 ? ref.slice(at + 1) : undefined
  const lastColon = base.lastIndexOf(':')
  const tagged = lastColon > base.lastIndexOf('/')
  return {
    repository: tagged ? base.slice(0, lastColon) : base,
    ...(tagged ? { tag: base.slice(lastColon + 1) } : {}),
    ...(digest ? { digest } : {}),
  }
}

// The repository coordinates only (host/ns/name) — the rule that matches an environment capability's declared image
// to a registry repository regardless of tag/digest (the same axis as adopted-image-reach).
export function imageRepositoryOf(ref: string): string {
  return splitImageRef(ref).repository
}

// A ref as it should READ. A digest is 71 characters, so a pinned ref renders as one long line whose tail — the part
// carrying the version — is exactly what CSS truncation eats: `ghcr.io/acme/env:1.4.0@sha256:…` collapses to a
// digest nobody can place. Keep repository+tag intact and abbreviate the digest instead; pair it with the full ref
// on `title` so the exact bytes stay one hover away.
export function displayImageRef(ref: string, digestChars = 12): string {
  const { repository, tag, digest } = splitImageRef(ref)
  const head = `${repository}${tag ? `:${tag}` : ''}`
  if (digest === undefined) return head
  const separator = digest.indexOf(':') // "sha256:<hex>" — abbreviate the hex, never the algorithm
  const algorithm = separator >= 0 ? digest.slice(0, separator + 1) : ''
  const hex = separator >= 0 ? digest.slice(separator + 1) : digest
  return `${head}@${algorithm}${hex.length > digestChars ? `${hex.slice(0, digestChars)}…` : hex}`
}
