'use client'

import { Paperclip, User } from 'lucide-react'

import type { AgentMessage } from '@/entities/agent-session'
import { Markdown } from '@/shared/ui/markdown'

import { AgentAvatar } from './agent-avatar'
import { ReferenceChip } from './mention-picker'

// One text turn in the transcript, laid out full-width (ChatGPT/Claude style) rather than as a chat bubble: a small
// role avatar + the content. Assistant text renders as markdown; a user turn shows its @-reference chips above the
// text. Reasoning and todos are pulled OUT into their own transcript items (see build-transcript) — this row is only
// the spoken text, so a tool-only assistant turn never renders here.
export function MessageRow({ message }: { message: AgentMessage }) {
  if (message.role === 'tool') return null

  const isUser = message.role === 'user'
  const hasText = message.content.trim().length > 0
  const hasRefs = message.references !== undefined && message.references.length > 0
  const hasAtts = message.attachments !== undefined && message.attachments.length > 0
  if (isUser && !hasText && !hasRefs && !hasAtts) return null
  if (!isUser && !hasText) return null

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 px-3 py-2.5 duration-200">
      <div className="flex gap-2.5">
        {isUser ? (
          <div className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <User className="size-3.5" />
          </div>
        ) : (
          <AgentAvatar />
        )}

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

          {hasText &&
            (isUser ? (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
                {message.content}
              </p>
            ) : (
              <Markdown
                content={message.content}
                className="text-[13px] leading-relaxed text-foreground"
              />
            ))}
        </div>
      </div>
    </div>
  )
}
