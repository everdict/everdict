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
// `compact` 은 캡션을 접고 아이콘만 남긴다 — 이슈 뷰처럼 레코드 작업이 브레드크럼 줄의 아이콘 버튼들(링크
// 복사·⋯)로 이미 정렬돼 있는 촘촘한 헤더용. 캡션은 aria-label/title 로 남으므로 문구·임무 판정은 한 곳에 그대로다.
// `fresh` 는 analyze/ask 임무에 edit 진입의 시작 방식을 준다: 열려 있던 스레드에 칩만 얹지 않고 새 대화에서
// 시작한다 — 그래야 그 임무의 프레이밍(빈 화면에서만 뜬다)이 진입할 때마다 실제로 보인다.
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
