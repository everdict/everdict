'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentReference } from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'

import { useMentionInChat } from '../model/infra-panel-context'

// "Analyze in chat" — from an entity detail page, drop this entity into the agent chat composer as an @-mention
// and reveal the chat (opening the infra panel if collapsed), so the user can ask about what they are looking at
// without hunting for it in the mention picker. The framed/direct dispatch lives in useMentionInChat.
export function MentionInChatButton({ reference }: { reference: AgentReference }) {
  const t = useTranslations('agentChat')
  const mention = useMentionInChat()

  return (
    <Button variant="outline" size="sm" onClick={() => mention(reference)}>
      <Sparkles />
      {t('sendToChat')}
    </Button>
  )
}
