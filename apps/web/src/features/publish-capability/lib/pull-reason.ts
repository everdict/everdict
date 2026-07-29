// pull 불가 사유 라벨 — 실 pull 검증(GET /workspace/image-registries/verify)의 reason 을 사용자 문구로.
// 저작 화면(환경 에디터)과 인벤토리 화면(워크벤치)이 같은 사유 어휘를 써야 해서 한 곳에 둔다.
export function pullReasonLabel(
  t: (key: string) => string,
  reason: 'ok' | 'auth' | 'not-found' | 'unreachable' | undefined
): string {
  if (reason === 'auth') return t('verifyAuth')
  if (reason === 'not-found') return t('verifyNotFound')
  if (reason === 'unreachable') return t('verifyUnreachable')
  return t('importedNotPullableBadge')
}

// ref 를 digest 로 고정 — 태그(또는 무태그)를 떼고 `repo@sha256:…` 로. host:port 의 콜론은 태그가 아니므로
// 마지막 슬래시 뒤에 있는 콜론만 태그로 본다. 이미 digest 가 박혀 있으면 그 digest 를 교체한다.
export function withDigest(image: string, digest: string): string {
  const at = image.indexOf('@')
  const base = at >= 0 ? image.slice(0, at) : image
  const lastColon = base.lastIndexOf(':')
  const repository = lastColon > base.lastIndexOf('/') ? base.slice(0, lastColon) : base
  return `${repository}@${digest}`
}
