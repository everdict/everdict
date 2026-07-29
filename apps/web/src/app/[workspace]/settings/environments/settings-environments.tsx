'use client'

import { useCallback } from 'react'

import { MENTION_IN_CHAT_MESSAGE, useInfraPanelOptional } from '@/widgets/infra-panel'
import { EnvironmentWorkbench } from '@/features/publish-capability'
import type { AgentReference } from '@/entities/agent-session'
import type { Capability } from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'

// Settings › Environments 의 대화 진입점 소유자 — 우측 대화 패널(위젯)은 피처가 직접 못 쓰므로(FSD 상향 임포트 금지)
// 페이지 레벨의 이 클라이언트 컴포넌트가 훅을 들고 워크벤치에 콜백만 내려준다(SettingsFilesExplorer 선례).
// 패널 iframe 안에서 열렸을 때는 부모 창으로 postMessage — MentionInChatButton/AskAgentButton 과 같은 이중 경로.
export function SettingsEnvironments(props: {
  authored: Capability[]
  imported: AdoptedEnvironment[]
  authors: Record<string, { name: string; avatarUrl?: string }>
  currentWorkspace: string
  currentSubject?: string
  isAdmin: boolean
  canWrite: boolean
  canImport: boolean
  canPublishPublic: boolean
  myWorkspaces: { id: string; name: string }[]
  imageRegistries: { name: string; host: string }[]
}) {
  const infra = useInfraPanelOptional()

  const dispatch = useCallback(
    (reference?: AgentReference, prompt?: string) => {
      const framed = typeof window !== 'undefined' && window.self !== window.top
      if (framed) {
        window.parent.postMessage(
          { type: MENTION_IN_CHAT_MESSAGE, reference, prompt },
          window.location.origin
        )
        return
      }
      if (prompt !== undefined) infra?.askAgent(prompt, reference)
      else if (reference !== undefined) infra?.mentionInChat(reference)
    },
    [infra]
  )

  return (
    <EnvironmentWorkbench
      {...props}
      onMention={(reference) => dispatch(reference)}
      onAskAgent={(prompt, reference) => dispatch(reference, prompt)}
    />
  )
}
