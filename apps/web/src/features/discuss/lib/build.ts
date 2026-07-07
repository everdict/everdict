import type { Comment } from '@/entities/comment'
import type { Member } from '@/entities/member'
import { fmtSubject } from '@/shared/lib/format'

import type { Mentionable, ThreadComment } from '../model/types'

// Display name — profile name first, else the email local-part (never expose the full email), else an abbreviated subject.
function displayName(m: Member | undefined, subject: string): string {
  return m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject)
}

// Workspace members → @mention candidates (display name + round avatar).
export function buildMentionables(members: Member[]): Mentionable[] {
  return members.map((m) => ({
    subject: m.subject,
    name: displayName(m, m.subject),
    ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
  }))
}

// Control-plane comment → display-ready ThreadComment (actor resolution + delete-permission computation). Assembled identically on any detail page.
export function buildThread(
  comments: Comment[],
  members: Member[],
  currentSubject: string | undefined,
  isAdmin: boolean
): ThreadComment[] {
  return comments.map((c) => {
    const m = members.find((x) => x.subject === c.author)
    return {
      id: c.id,
      ...(c.parentId ? { parentId: c.parentId } : {}),
      actor: {
        name: displayName(m, c.author),
        ...(m?.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
        known: Boolean(m),
      },
      body: c.body,
      at: c.createdAt,
      canDelete: c.author === currentSubject || isAdmin,
    }
  })
}
