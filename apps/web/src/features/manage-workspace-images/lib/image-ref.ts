// 이미지 ref("host/ns/name:tag@sha256:…")에서 리포지토리 좌표(host/ns/name)만 남긴다 — 환경 capability 가
// 선언한 이미지와 이 리포지토리를 태그/다이제스트 무관하게 잇는 매칭 규칙(adopted-image-reach 와 같은 축).
export function imageRepositoryOf(ref: string): string {
  const withoutDigest = ref.split('@')[0]
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  // 마지막 콜론이 마지막 슬래시 뒤에 있을 때만 태그다(그 앞이면 "host:port"의 포트).
  if (lastColon > lastSlash) return withoutDigest.slice(0, lastColon)
  return withoutDigest
}
