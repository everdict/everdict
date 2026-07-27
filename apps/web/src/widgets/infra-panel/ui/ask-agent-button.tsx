'use client'

import { Sparkles } from 'lucide-react'

import type { AgentReference } from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'

import { MENTION_IN_CHAT_MESSAGE, useInfraPanelOptional } from '../model/infra-panel-context'

// "Ask the agent" — the prompt-carrying sibling of MentionInChatButton: from a detail page, open the agent chat
// with a DRAFT PROMPT pre-typed (and the entity referenced), so "have the agent do X with this" is one click plus
// send. Nothing auto-sends — the member reviews the draft. Same dual path as the mention button: panel context in
// the eval shell, same-origin postMessage from inside a panel iframe.
export function AskAgentButton({
  prompt,
  reference,
  label,
  variant = 'outline',
}: {
  prompt: string
  reference?: AgentReference
  label: string
  variant?: 'primary' | 'outline'
}) {
  const infra = useInfraPanelOptional()

  const onClick = () => {
    const framed = typeof window !== 'undefined' && window.self !== window.top
    if (framed) {
      window.parent.postMessage(
        { type: MENTION_IN_CHAT_MESSAGE, reference, prompt },
        window.location.origin
      )
      return
    }
    infra?.askAgent(prompt, reference)
  }

  return (
    <Button variant={variant} size="sm" onClick={onClick}>
      <Sparkles />
      {label}
    </Button>
  )
}
