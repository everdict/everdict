import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '@/entities/agent-session'

import { buildTranscript } from './transcript'

// The end-to-end shape the chat actually receives: an assistant turn whose toolCalls include create_sandbox,
// followed by the role:"tool" record the agent persists verbatim (the create_sandbox response IS the sandbox
// RunRecord). If this stops producing a delegation item, the card silently disappears from the transcript.
const msg = (over: Partial<AgentMessage> & { id: string; seq: number }): AgentMessage =>
  ({
    role: 'assistant',
    content: '',
    createdAt: '2026-08-06T00:00:00.000Z',
    ...over,
  }) as AgentMessage

describe('buildTranscript — a delegation becomes its own transcript item', () => {
  const messages: AgentMessage[] = [
    msg({ id: 'm1', seq: 1, role: 'user', content: 'fix the regression' }),
    msg({
      id: 'm2',
      seq: 2,
      content: 'Handing this to the repair environment.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'create_sandbox',
          arguments: JSON.stringify({
            profile: { id: 'fixer' },
            brief: { goal: 'make the cases pass' },
          }),
        },
      ],
    }),
    msg({
      id: 'm3',
      seq: 3,
      role: 'tool',
      toolCallId: 'call-1',
      content: JSON.stringify(
        { id: 'run-42', kind: 'sandbox', session: { conversation: true } },
        null,
        2
      ),
    }),
  ]

  it('carries the profile, the goal and the session id the card needs to attach', () => {
    const items = buildTranscript(messages, [])
    const delegation = items.find((i) => i.kind === 'delegation')
    expect(delegation).toBeDefined()
    if (delegation?.kind !== 'delegation') return
    expect(delegation.delegation).toMatchObject({
      profileId: 'fixer',
      goal: 'make the cases pass',
      sessionRunId: 'run-42',
      status: 'open',
    })
  })

  it('does not swallow the assistant text that announced it', () => {
    const items = buildTranscript(messages, [])
    const said = items
      .filter((i) => i.kind === 'message')
      .map((i) => (i.kind === 'message' ? i.message.content : ''))
    expect(said.some((c) => c.includes('Handing this to the repair environment'))).toBe(true)
  })
})
