// semver utils for system-managed versioning — compute the next version from existing versions on dataset registration (avoiding raw input).
export type BumpKind = 'patch' | 'minor' | 'major'

const RE = /^(\d+)\.(\d+)\.(\d+)$/

export function isSemver(v: string): boolean {
  return RE.test(v.trim())
}

function parse(v: string): [number, number, number] | undefined {
  const m = RE.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

// The max semver among the given versions (parseable ones only). undefined if none.
export function maxSemver(versions: readonly string[]): string | undefined {
  let best: { raw: string; t: [number, number, number] } | undefined
  for (const raw of versions) {
    const t = parse(raw)
    if (!t) continue
    if (!best || cmp(t, best.t) > 0) best = { raw, t }
  }
  return best?.raw
}

// Compute the next version (system-managed). If unparseable, return the original as-is.
export function bumpSemver(version: string, kind: BumpKind): string {
  const t = parse(version)
  if (!t) return version
  const [maj, min, pat] = t
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// Sort semver descending (latest first) — the display order for the version selector / diff picker. Unparseable versions go last (relative order preserved).
export function sortSemverDesc(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => {
    const pa = parse(a)
    const pb = parse(b)
    if (pa && pb) return cmp(pb, pa)
    if (pa) return -1
    if (pb) return 1
    return 0
  })
}

// Existing versions of one id from the dataset list (owned + shared merged, deduplicated).
export function versionsForId(
  list: ReadonlyArray<{ id: string; versions: string[] }>,
  id: string
): string[] {
  const key = id.trim()
  if (!key) return []
  const out = new Set<string>()
  for (const d of list) if (d.id === key) for (const v of d.versions) out.add(v)
  return [...out]
}
