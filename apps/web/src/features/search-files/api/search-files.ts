'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface FileMatch {
  path: string
  // Present only for a CONTENT match — a path-glob hit has no line to point at, and inventing 1 would tell
  // a reader the term is on the first line.
  line?: number
  excerpt?: string
}

export interface SearchFilesResult {
  ok: boolean
  matches?: FileMatch[]
  // A cap fired, so the result is a FLOOR. Saying "12 matches" over a truncated answer is the one reading
  // the control plane's own description warns against.
  truncated?: boolean
  error?: string
}

// Server action: find files by path glob and/or grep their content. The control plane requires at least one
// of the two and refuses a search that asks for everything — this action forwards that refusal rather than
// guessing a default, because a default here would walk the whole tree on an empty box.
export async function searchFilesAction(q: {
  glob?: string
  pattern?: string
  path?: string
}): Promise<SearchFilesResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.searchFiles<{ matches?: FileMatch[]; truncated?: boolean }>(ctx, q)
    return { ok: true, matches: out.matches ?? [], ...(out.truncated ? { truncated: true } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
