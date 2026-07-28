'use client'

import { useEffect, useRef } from 'react'

import type { AgentReference } from '@/entities/agent-session'

import { useInfraPanelOptional } from '../model/infra-panel-context'

// Reveal the agent chat on arrival — a studio entry ("New analysis" → the analyze canvas) lands with the
// conversation already open on the right, so the natural-language path IS the creation path instead of a
// hidden affordance. Renders nothing and fires once per mount; the askAgent contract applies (draft prompt
// pre-typed, reference chipped — nothing auto-sends, the member reviews). No provider (embed iframe) = no-op.
export function AgentChatOpener({
  prompt,
  reference,
}: {
  prompt?: string
  reference?: AgentReference
}) {
  const infra = useInfraPanelOptional()
  const opened = useRef(false)

  useEffect(() => {
    if (opened.current || !infra) return
    opened.current = true
    if (prompt) infra.askAgent(prompt, reference)
    else if (reference) infra.mentionInChat(reference)
    else infra.openTab('agent')
  }, [infra, prompt, reference])

  return null
}
