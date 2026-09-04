'use client'

import { useCallback } from 'react'

import { MENTION_IN_CHAT_MESSAGE, useInfraPanelOptional } from '@/widgets/infra-panel'
import { EnvironmentWorkbench } from '@/features/publish-capability'
import type { AgentReference } from '@/entities/agent-session'
import type { Capability } from '@/entities/capability'
import type { AdoptedEnvironment } from '@/entities/environment-adoption'

// The owner of Settings › Environments' conversation entry point — a feature cannot use the right conversation panel (a widget) directly (FSD
// forbids importing upward), so this page-level client component holds the hook and passes only a callback down to the workbench (following SettingsFilesExplorer).
// Opened inside the panel iframe it postMessages to the parent window instead — the same dual path as MentionInChatButton/AskAgentButton.
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

  // Every conversation entry on this surface is work that creates or edits an environment, so the mission is fixed here (the workbench does not know about missions).
  const dispatch = useCallback(
    (reference?: AgentReference, prompt?: string) => {
      const framed = typeof window !== 'undefined' && window.self !== window.top
      if (framed) {
        window.parent.postMessage(
          { type: MENTION_IN_CHAT_MESSAGE, reference, prompt, mission: 'environmentEdit' },
          window.location.origin
        )
        return
      }
      if (prompt !== undefined) infra?.askAgent(prompt, reference, 'environmentEdit')
      else if (reference !== undefined) infra?.mentionInChat(reference, 'environmentEdit')
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
