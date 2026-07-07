// A loose client mirror of @everdict/core classifyImageRef (web has no @everdict/* deps — same convention as the harnessInstanceSpecSchema mirror).
// The 4-way image reference classification from the workspace registry's viewpoint. The decision rules are the control plane's SSOT
// (docs/architecture/workspace-image-registry.md) — this mirror is for badge display.
export type ImageRefClass = 'workspace' | 'external' | 'local' | 'unqualified'

export interface ImageRegistryCoordinates {
  host: string
  namespace?: string
}

// docker reference rule: the first path component is a registry host only when it contains '.'/':' or is "localhost".
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

// registry — since a workspace can have multiple registries, an array is also accepted (matching any one → workspace).
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
