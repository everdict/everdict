import { describe, expect, it } from 'vitest'

import { AGENT_CHAT_MISSION_INTENTS, startsFreshConversation } from './schema'

describe('chat entry — which entries start their own conversation', () => {
  it('starts fresh for an edit mission, because authoring never continues someone else’s thread', () => {
    expect(startsFreshConversation({ mission: 'skillEdit' })).toBe(true)
    expect(startsFreshConversation({ mission: 'harnessEdit' })).toBe(true)
  })

  it('keeps the open thread for analyze/ask, so two scorecards can be compared in one conversation', () => {
    expect(startsFreshConversation({ mission: 'scorecardAnalyze' })).toBe(false)
    expect(startsFreshConversation({ mission: 'knowledgeAsk' })).toBe(false)
  })

  it('starts fresh when an analyze entry declares itself the subject of the conversation', () => {
    // The issue detail and the blank analysis canvas use this exception. Mission framing appears only on an empty screen, so with this returning
    // false the panel stays on whatever conversation was open even after entering — and the screen framed for that work is never seen at all.
    expect(startsFreshConversation({ mission: 'issueAnalyze', fresh: true })).toBe(true)
    expect(startsFreshConversation({ mission: 'viewAnalyze', fresh: true })).toBe(true)
  })

  it('leaves a mission-less entry (the @-picker, the trace browser) on the open thread', () => {
    expect(startsFreshConversation({})).toBe(false)
    expect(startsFreshConversation({ fresh: false })).toBe(false)
  })

  it('is decided by the intent table, so a new mission inherits the rule instead of restating it', () => {
    for (const [mission, intent] of Object.entries(AGENT_CHAT_MISSION_INTENTS)) {
      expect(
        startsFreshConversation({ mission: mission as keyof typeof AGENT_CHAT_MISSION_INTENTS }),
        `${mission} (${intent})`
      ).toBe(intent === 'edit')
    }
  })
})
