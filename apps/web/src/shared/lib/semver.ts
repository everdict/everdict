// 시스템 관리 버저닝용 semver 유틸 — 데이터셋 등록 시 기존 버전 기반으로 다음 버전을 계산(raw 입력 회피).
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

// 주어진 버전들 중 semver 최댓값(파싱 가능한 것만). 없으면 undefined.
export function maxSemver(versions: readonly string[]): string | undefined {
  let best: { raw: string; t: [number, number, number] } | undefined
  for (const raw of versions) {
    const t = parse(raw)
    if (!t) continue
    if (!best || cmp(t, best.t) > 0) best = { raw, t }
  }
  return best?.raw
}

// 다음 버전 계산(시스템 관리). 파싱 불가하면 원본 그대로.
export function bumpSemver(version: string, kind: BumpKind): string {
  const t = parse(version)
  if (!t) return version
  const [maj, min, pat] = t
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// semver 내림차순 정렬(최신 먼저) — 버전 선택기/diff 피커의 표시 순서. 파싱 불가 버전은 뒤로(상대순서 유지).
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

// 데이터셋 목록에서 한 id 의 기존 버전(소유 + 공유 병합, 중복 제거).
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
