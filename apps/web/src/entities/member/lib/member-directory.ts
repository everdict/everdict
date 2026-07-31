'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

import { workspaceSlugFromPath } from '@/shared/auth/workspace-scope'
import { fmtSubject } from '@/shared/lib/format'

import { membersSchema } from '../model/schema'

// subject → human identity. A record only ever stores the opaque Keycloak subject, so any client surface that
// shows WHO did something needs this lookup; server components get the same thing from `listMembers` directly.
export type MemberProfile = { name: string; avatarUrl?: string }
export type MemberDirectory = Record<string, MemberProfile>

const EMPTY: MemberDirectory = {}

// One in-flight request per workspace shared by every mounted consumer, and the result kept for the rest of the
// session: member names are stable, and a history list must not turn into N member lookups. Keyed by workspace so
// switching workspaces (a client-side navigation) can never show the previous workspace's names.
const cache = new Map<string, MemberDirectory>()
const inflight = new Map<string, Promise<MemberDirectory>>()

async function loadDirectory(workspace: string): Promise<MemberDirectory> {
  const cached = cache.get(workspace)
  if (cached !== undefined) return cached
  const pending = inflight.get(workspace)
  if (pending !== undefined) return pending
  const request = (async (): Promise<MemberDirectory> => {
    try {
      const res = await fetch('/api/members', { cache: 'no-store' })
      if (!res.ok) return EMPTY
      const parsed = membersSchema.safeParse(await res.json())
      if (!parsed.success) return EMPTY
      const directory: MemberDirectory = {}
      for (const m of parsed.data) {
        directory[m.subject] = {
          name: m.name ?? m.email?.split('@')[0] ?? m.subject,
          ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
        }
      }
      cache.set(workspace, directory) // only a successful read is remembered — a failure retries on the next mount
      return directory
    } catch {
      return EMPTY // enrichment is cosmetic: the caller falls back to the subject rather than failing the view
    } finally {
      inflight.delete(workspace)
    }
  })()
  inflight.set(workspace, request)
  return request
}

// Lazy member directory for client components. Returns `{}` until it loads (and if it can't load), so callers
// render the subject fallback instead of an empty author.
export function useMemberDirectory(): MemberDirectory {
  const workspace = workspaceSlugFromPath(usePathname() ?? '')
  const [directory, setDirectory] = useState<MemberDirectory>(
    () => (workspace !== undefined ? cache.get(workspace) : undefined) ?? EMPTY
  )

  useEffect(() => {
    if (workspace === undefined) return
    let alive = true
    void loadDirectory(workspace).then((d) => {
      if (alive) setDirectory(d)
    })
    return () => {
      alive = false
    }
  }, [workspace])

  return directory
}

// The name to show for a subject — the member's profile name, or the shortened subject when the directory hasn't
// loaded or the member has since left the workspace (a past revision still names whoever published it).
export function memberNameOf(directory: MemberDirectory, subject: string): string {
  return directory[subject]?.name ?? fmtSubject(subject)
}
