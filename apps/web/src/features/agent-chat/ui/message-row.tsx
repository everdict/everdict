'use client'

import { memo } from 'react'
import { Paperclip, User } from 'lucide-react'

import type { AgentMessage } from '@/entities/agent-session'
import { Avatar } from '@/shared/ui/avatar'
import { Markdown } from '@/shared/ui/markdown'

import { ReferenceChip } from './mention-picker'

// The signed-in member shown next to their own turns — resolved by the shell (profile name/avatar) and threaded down.
export interface ChatUser {
  name: string
  avatarUrl?: string
}

// The member's profile avatar for a user turn (monogram fallback while the profile hasn't loaded).
export function UserBadge({ user }: { user?: ChatUser }) {
  if (user === undefined)
    return (
      <div className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <User className="size-3.5" />
      </div>
    )
  return (
    <Avatar
      name={user.name}
      {...(user.avatarUrl !== undefined ? { url: user.avatarUrl } : {})}
      size="md"
      className="rounded-full"
    />
  )
}

// One text turn in the transcript, laid out full-width (ChatGPT/Claude style) rather than as a chat bubble. A user
// turn shows the member's profile avatar + their @-reference chips above the text; assistant text renders as bare
// markdown with NO avatar/gutter (the agent needs no face — its words are the surface). Reasoning, todos, and
// sub-agent activity are pulled OUT into their own transcript items (see build-transcript).
// MEMOIZED, and this one is not an optimization detail: an assistant turn re-parses its markdown through the whole
// unified pipeline (remark-gfm → rehype-raw → sanitize) on every render, and the composer's draft lives one
// component up — so without this every keystroke re-parsed the ENTIRE transcript (measured ~46ms at 20 turns,
// before the browser's own reconciliation). A settled message is immutable, so identity comparison is exact.
export const MessageRow = memo(function MessageRow({
  message,
  user,
}: {
  message: AgentMessage
  user?: ChatUser
}) {
  if (message.role === 'tool') return null

  const isUser = message.role === 'user'
  const hasText = message.content.trim().length > 0
  const hasRefs = message.references !== undefined && message.references.length > 0
  const hasAtts = message.attachments !== undefined && message.attachments.length > 0
  if (isUser && !hasText && !hasRefs && !hasAtts) return null
  if (!isUser && !hasText) return null

  if (!isUser)
    return (
      <div className="animate-in fade-in-0 slide-in-from-bottom-1 px-3 py-2.5 duration-200">
        <Markdown
          content={message.content}
          className="text-[13px] leading-relaxed text-foreground"
        />
      </div>
    )

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 px-3 py-2.5 duration-200">
      <div className="flex gap-2.5">
        <UserBadge user={user} />
        <div className="min-w-0 flex-1 space-y-1.5">
          {(hasRefs || hasAtts) && (
            <div className="flex flex-wrap gap-1">
              {message.references?.map((r, i) => (
                <ReferenceChip key={`${r.type}:${r.id}:${i}`} reference={r} />
              ))}
              {message.attachments?.map((a, i) => (
                <span
                  key={`${a.name}:${i}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                >
                  <Paperclip className="size-3 shrink-0 text-muted-foreground/70" />
                  <span className="truncate font-mono text-foreground/80">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {hasText && (
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
              {message.content}
            </p>
          )}
        </div>
      </div>
    </div>
  )
})
