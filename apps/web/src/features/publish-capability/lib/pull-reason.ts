// pull 불가 사유 라벨 — 실 pull 검증(GET /workspace/image-registries/verify)의 reason 을 사용자 문구로.
// 저작 화면(환경 에디터)과 인벤토리 화면(워크벤치)이 같은 사유 어휘를 써야 해서 한 곳에 둔다.
export function pullReasonLabel(
  t: (key: string) => string,
  reason: 'ok' | 'auth' | 'not-found' | 'unreachable' | 'unregistered-host' | undefined
): string {
  if (reason === 'auth') return t('verifyAuth')
  if (reason === 'not-found') return t('verifyNotFound')
  if (reason === 'unreachable') return t('verifyUnreachable')
  if (reason === 'unregistered-host') return t('verifyUnregisteredHost')
  return t('importedNotPullableBadge')
}

// Pin the ref to a digest, keeping the tag it already carries — `repo:tag@sha256:…`. The digest is what resolves
// (an OCI client ignores the tag when a digest is present), so the pin is exactly as reproducible as a bare
// `repo@sha256:…`; the tag is the only place a reader gets a VERSION from, and dropping it left the environment and
// topology views showing an image nobody could identify. An already-pinned digest is replaced.
export function withDigest(image: string, digest: string): string {
  const at = image.indexOf('@')
  const base = at >= 0 ? image.slice(0, at) : image
  return `${base}@${digest}`
}
