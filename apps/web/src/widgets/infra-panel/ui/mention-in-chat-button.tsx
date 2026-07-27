'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentReference } from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'

import { MENTION_IN_CHAT_MESSAGE, useInfraPanelOptional } from '../model/infra-panel-context'

// "Analyze in chat" — from an entity detail page, drop this entity into the agent chat composer as an @-mention
// and reveal the chat (opening the infra panel if collapsed), so the user can ask about what they are looking at
// without hunting for it in the mention picker. On an eval page (left shell) it calls the panel context directly;
// on a run/runtime page rendered inside the panel's own iframe there is no provider, so it posts up to the parent
// shell — which owns the chat — over the same-origin postMessage bridge.
export function MentionInChatButton({ reference }: { reference: AgentReference }) {
  const t = useTranslations('agentChat')
  const infra = useInfraPanelOptional()

  const onClick = () => {
    const framed = typeof window !== 'undefined' && window.self !== window.top
    if (framed) {
      window.parent.postMessage(
        { type: MENTION_IN_CHAT_MESSAGE, reference },
        window.location.origin
      )
      return
    }
    infra?.mentionInChat(reference)
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Sparkles />
      {t('sendToChat')}
    </Button>
  )
}
