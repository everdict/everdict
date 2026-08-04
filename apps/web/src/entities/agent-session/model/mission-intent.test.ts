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
    // 이슈 상세와 빈 분석 캔버스가 이 예외를 쓴다. 임무 프레이밍은 빈 화면에서만 뜨므로, 이게 false 로
    // 돌아오면 진입해도 패널은 열려 있던 대화 그대로 — 그 작업에 맞는 화면을 아예 못 보게 된다.
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
