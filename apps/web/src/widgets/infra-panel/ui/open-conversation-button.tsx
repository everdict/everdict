'use client'

import { MessagesSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { OPEN_AGENT_SESSION_MESSAGE, useInfraPanelOptional } from '../model/infra-panel-context'

// 대화 열기 — 이미 존재하는 대화를 오른쪽 패널의 에이전트 챗에서 연다. MentionInChatButton/AskAgentButton 이
// "이 엔티티를 챗에 넘긴다"라면 이쪽은 "그 대화로 돌아간다"이고, run 상세의 에이전트 턴처럼 대화 id(group.id)를
// 이미 아는 표면이 쓴다. 진입 경로는 형제 버튼들과 같다: eval 셸에서는 패널 컨텍스트, 패널 iframe 안에서
// 렌더될 때는 부모로 same-origin postMessage.
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
