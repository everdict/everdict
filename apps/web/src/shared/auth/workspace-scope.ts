// Shared constants that carry the active workspace across URL ↔ cookie ↔ header.
// Not server-only — imported from both middleware (edge runtime) and server components (to avoid drift from duplicate definitions).
export const ACTIVE_WORKSPACE_COOKIE = 'everdict-workspace'
// Middleware injects the URL's first segment as this request header, and authContext reads it and forwards it as the control plane scope (x-everdict-workspace).
export const ACTIVE_WORKSPACE_HEADER = 'x-everdict-active-workspace'
export const ACTIVE_WORKSPACE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year (persist the most-recent workspace)

// Workspace slug format (same as the control plane). If the first segment isn't this format, it's not treated as a workspace.
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]*$/
// Top-level routes that aren't workspaces (operate without a workspace context). Must not be reserved as a slug.
export const RESERVED_TOP_LEVEL = new Set(['api', 'onboarding', 'new-workspace', 'invite'])

// Whether the path's first segment is a workspace slug (excluding reserved words / non-slugs).
export function workspaceSlugFromPath(pathname: string): string | undefined {
  const seg = pathname.split('/')[1]
  if (!seg || RESERVED_TOP_LEVEL.has(seg) || !WORKSPACE_SLUG.test(seg)) return undefined
  return seg
}

// A workspace id is lowercase, and the display NAME a person reads is usually capitalised — so `/Digo` is the
// address somebody types for the workspace called "Digo". It used to fall through as a non-slug: no workspace
// header was injected, the layout found no membership for `Digo`, and it redirected the reader into their
// DEFAULT workspace — another workspace's data under the address they asked for, which reads as data loss.
// The first segment is normalised instead, the same courtesy a lowercased issue identifier already gets.
// Returns the canonical path (first segment lowercased) when the URL is not already canonical, else undefined.
export function canonicalWorkspacePath(pathname: string): string | undefined {
  const [, seg, ...rest] = pathname.split('/')
  if (!seg || seg === seg.toLowerCase()) return undefined
  const canonical = seg.toLowerCase()
  if (RESERVED_TOP_LEVEL.has(canonical) || !WORKSPACE_SLUG.test(canonical)) return undefined
  return ['', canonical, ...rest].join('/')
}
