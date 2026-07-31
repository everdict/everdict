'use client'

import { useEffect, useRef } from 'react'

import type { AgentChatMission, AgentReference } from '@/entities/agent-session'

import { useInfraPanelOptional } from '../model/infra-panel-context'

// Reveal the agent chat on arrival — a studio entry ("New analysis" → the analyze canvas) lands with the
// conversation already open on the right, so the natural-language path IS the creation path instead of a
// hidden affordance. Renders nothing and fires once per mount; the askAgent contract applies (draft prompt
// pre-typed, reference chipped — nothing auto-sends, the member reviews). A mission frames the chat for the
// studio's task (analysis canvas, agent crafting). No provider (embed iframe) = no-op.
export function AgentChatOpener({
  prompt,
  reference,
  mission,
  fresh,
}: {
  prompt?: string
  reference?: AgentReference
  mission?: AgentChatMission
  /** This entry CREATES the thing (a new analysis) — start a new conversation instead of continuing one. */
  fresh?: boolean
}) {
  const infra = useInfraPanelOptional()
  const opened = useRef(false)

  useEffect(() => {
    if (opened.current || !infra) return
    opened.current = true
    if (prompt) infra.askAgent(prompt, reference, mission, fresh)
    else if (reference) infra.mentionInChat(reference, mission)
    else infra.openTab('agent')
  }, [infra, prompt, reference, mission, fresh])

  return null
}
