'use client'

import { MessagesSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { OPEN_AGENT_SESSION_MESSAGE, useInfraPanelOptional } from '../model/infra-panel-context'

// Open a conversation — it opens an EXISTING conversation in the right panel's agent chat. Where MentionInChatButton/AskAgentButton are
// "hand this entity to the chat", this is "go BACK to that conversation", and it is used by a surface that already knows the conversation id
// (group.id), such as an agent turn on a run detail. The entry path is the same as its sibling buttons': the panel context inside the eval
// shell, and a same-origin postMessage to the parent when rendered inside the panel iframe.
export function OpenConversationButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations('runsPage')
  const infra = useInfraPanelOptional()

  const onClick = () => {
    const framed = typeof window !== 'undefined' && window.self !== window.top
    if (framed) {
      window.parent.postMessage(
        { type: OPEN_AGENT_SESSION_MESSAGE, sessionId },
        window.location.origin
      )
      return
    }
    infra?.openAgentSession(sessionId)
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <MessagesSquare className="size-4" />
      {t('openConversation')}
    </Button>
  )
}
