'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentChatMission, AgentReference } from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'

import { useMentionInChat } from '../model/infra-panel-context'

// "Analyze in chat" — from an entity detail page, drop this entity into the agent chat composer as an @-mention
// and reveal the chat (opening the infra panel if collapsed), so the user can ask about what they are looking at
// without hunting for it in the mention picker. The framed/direct dispatch lives in useMentionInChat.
// `label` overrides the default caption for pages where the chat is the edit path (e.g. skills: "Edit in chat").
// `mission` marks such a specialized entry: the chat keeps its structure but frames itself for that task
// (tailored empty-state copy + suggestions) instead of the generic "ask about your workspace" framing.
export function MentionInChatButton({
  reference,
  label,
  mission,
}: {
  reference: AgentReference
  label?: string
  mission?: AgentChatMission
}) {
  const t = useTranslations('agentChat')
  const mention = useMentionInChat()

  return (
    <Button variant="outline" size="sm" onClick={() => mention(reference, mission)}>
      <Sparkles />
      {label ?? t('sendToChat')}
    </Button>
  )
}
