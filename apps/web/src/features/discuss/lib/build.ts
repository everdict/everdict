import type { Comment } from '@/entities/comment'
import type { Member } from '@/entities/member'
import { fmtSubject } from '@/shared/lib/format'

import type { Mentionable, ThreadComment } from '../model/types'

// Reserved author subject of agent-authored comments — mirrors the control plane's sentinel (a value, so the
// type-only @everdict/contracts dep can't carry it).
export const AGENT_COMMENT_AUTHOR = 'everdict:agent'
// The agent's @mention handle + display name in threads.
export const AGENT_MENTION_NAME = 'everdict'

// Display name — profile name first, else the email local-part (never expose the full email), else an abbreviated subject.
function displayName(m: Member | undefined, subject: string): string {
  return m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject)
}

// Workspace members → @mention candidates (display name + round avatar). The synthetic @everdict entry leads —
// picking it asks the agent (askAgent), it is never a notification target.
export function buildMentionables(members: Member[]): Mentionable[] {
  return [
    { subject: AGENT_COMMENT_AUTHOR, name: AGENT_MENTION_NAME, isAgent: true },
    ...members.map((m) => ({
      subject: m.subject,
      name: displayName(m, m.subject),
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    })),
  ]
}

// Control-plane comment → display-ready ThreadComment (actor resolution + delete-permission computation). Assembled identically on any detail page.
export function buildThread(
  comments: Comment[],
  members: Member[],
  currentSubject: string | undefined,
  isAdmin: boolean
): ThreadComment[] {
  return comments.map((c) => {
    if (c.authorKind === 'agent') {
      // Agent answers render by status (spinner/approval/markdown) — deletable by an admin like any comment.
      return {
        id: c.id,
        ...(c.parentId ? { parentId: c.parentId } : {}),
        actor: { name: 'Everdict', known: false },
        body: c.body,
        at: c.createdAt,
        canDelete: isAdmin,
        isAgent: true,
        ...(c.agentStatus ? { agentStatus: c.agentStatus } : {}),
        ...(c.agentActivity ? { agentActivity: c.agentActivity } : {}),
        ...(c.agentSessionId ? { agentSessionId: c.agentSessionId } : {}),
      }
    }
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
