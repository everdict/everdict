// @everdict/core classifyImageRef 의 느슨한 클라이언트 미러(web 은 @everdict/* 무의존 — harnessInstanceSpecSchema 미러와 동일 관례).
// 워크스페이스 레지스트리 관점의 이미지 참조 4분류. 판정 규칙은 컨트롤플레인이 SSOT
// (docs/architecture/workspace-image-registry.md) — 여기 미러는 배지 표시용.
export type ImageRefClass = 'workspace' | 'external' | 'local' | 'unqualified'

export interface ImageRegistryCoordinates {
  host: string
  namespace?: string
}

// docker reference 규칙: 첫 경로 컴포넌트에 '.'/':' 가 있거나 "localhost" 일 때만 레지스트리 호스트.
function splitRef(ref: string): { host?: string; path: string } {
  const atIndex = ref.indexOf('@')
  let rest = atIndex >= 0 ? ref.slice(0, atIndex) : ref
  const lastSlash = rest.lastIndexOf('/')
  const colonIndex = rest.indexOf(':', lastSlash + 1)
  rest = colonIndex >= 0 ? rest.slice(0, colonIndex) : rest
  const firstSlash = rest.indexOf('/')
  const first = firstSlash >= 0 ? rest.slice(0, firstSlash) : rest
  const isHost =
    firstSlash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')
  return isHost ? { host: first, path: rest.slice(firstSlash + 1) } : { path: rest }
}

function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

// registry — 워크스페이스 레지스트리가 복수라 배열도 받는다(어느 하나에 매칭되면 workspace).
export function classifyImageRef(
  ref: string,
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[]
): ImageRefClass {
  const registries = Array.isArray(registry) ? registry : registry ? [registry] : []
  const { host, path } = splitRef(ref.trim())
  if (host) {
    if (isLoopbackHost(host)) return 'local'
    if (
      registries.some(
        (r) =>
          host === r.host &&
          (!r.namespace || path === r.namespace || path.startsWith(`${r.namespace}/`))
      )
    )
      return 'workspace'
    return 'external'
  }
  return path.includes('/') ? 'external' : 'unqualified'
}
