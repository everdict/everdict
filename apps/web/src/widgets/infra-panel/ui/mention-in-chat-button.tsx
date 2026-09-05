'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  AGENT_CHAT_MISSION_INTENTS,
  type AgentChatMission,
  type AgentReference,
} from '@/entities/agent-session'
import { Button } from '@/shared/ui/button'

import { useMentionInChat } from '../model/infra-panel-context'

// "Analyze in chat" — from an entity detail page, drop this entity into the agent chat composer as an @-mention
// and reveal the chat (opening the infra panel if collapsed), so the user can ask about what they are looking at
// without hunting for it in the mention picker. The framed/direct dispatch lives in useMentionInChat.
// `mission` marks a specialized entry: the chat keeps its structure but frames itself for that task
// (tailored empty-state copy + suggestions) instead of the generic "ask about your workspace" framing. The
// caption follows the mission's intent — an edit mission reads "Edit in chat", everything else keeps the
// analyze caption — and `label` overrides both for surfaces with their own wording (e.g. knowledge: "Ask in chat").
// `compact` folds the caption away and leaves the icon — for a dense header like the issue view, where record actions are already lined up as
// icon buttons on the breadcrumb row (copy link, ⋯). The caption survives as aria-label/title, so the wording and the mission decision stay in one place.
// `fresh` gives an analyze/ask mission the START behaviour of an edit entry: rather than dropping a chip onto whatever thread was open, it begins
// a NEW conversation — which is what makes that mission's framing (visible only on an empty screen) actually appear on every entry.
export function MentionInChatButton({
  reference,
  label,
  mission,
  compact,
  fresh,
}: {
  reference: AgentReference
  label?: string
  mission?: AgentChatMission
  compact?: boolean
  fresh?: boolean
}) {
  const t = useTranslations('agentChat')
  const mention = useMentionInChat()
  const caption =
    label ??
    (mission !== undefined && AGENT_CHAT_MISSION_INTENTS[mission] === 'edit'
      ? t('editInChat')
      : t('sendToChat'))

  if (compact)
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={caption}
        title={caption}
        onClick={() => mention(reference, mission, fresh)}
      >
        <Sparkles />
      </Button>
    )

  return (
    <Button variant="outline" size="sm" onClick={() => mention(reference, mission, fresh)}>
      <Sparkles />
      {caption}
    </Button>
  )
}
