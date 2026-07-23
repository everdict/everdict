'use client'

import { Copy, Paperclip, RefreshCw, User } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentMessage } from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'

import { AgentAvatar } from './agent-avatar'
import { ReferenceChip } from './mention-picker'
import { ToolCall } from './tool-call'

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error('Copy failed')
  }
}

// One turn in the transcript, laid out full-width (ChatGPT/Claude style) rather than as a chat bubble: a small
// role avatar + the content, with hover actions. Assistant text renders as markdown; a user turn shows its
// @-reference chips above the text; tool turns are folded into the preceding assistant row as tool-call cards.
export function MessageRow({
  message,
  resultByCallId,
  isLastAssistant,
  onRegenerate,
}: {
  message: AgentMessage
  resultByCallId: Map<string, string>
  isLastAssistant: boolean
  onRegenerate?: () => void
}) {
  const t = useTranslations('agentChat')

  if (message.role === 'tool') return null

  const isUser = message.role === 'user'
  const hasText = message.content.trim().length > 0
  const hasRefs = message.references !== undefined && message.references.length > 0
  const hasAtts = message.attachments !== undefined && message.attachments.length > 0
  const hasTools = message.toolCalls !== undefined && message.toolCalls.length > 0
  if (isUser && !hasText && !hasRefs && !hasAtts) return null
  if (!isUser && !hasText && !hasTools) return null

  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 px-3 py-2.5 duration-200">
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

          {hasTools &&
            message.toolCalls?.map((tc) => (
              <ToolCall
                key={tc.id}
                name={tc.name}
                args={tc.arguments}
                result={resultByCallId.get(tc.id)}
              />
            ))}

          {!isUser && hasText && (
            <div className="flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('copy')}
                onClick={() => void copyText(message.content, t('copied'))}
              >
                <Copy />
              </Button>
              {isLastAssistant && onRegenerate && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('regenerate')}
                  onClick={onRegenerate}
                >
                  <RefreshCw />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
