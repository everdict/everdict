import { describe, expect, it } from 'vitest'

import { ContextBlock } from './context-block'
import { TranscriptList } from './conversation-view'
import { DelegationCard } from './delegation-card'
import { MessageRow } from './message-row'
import { ReasoningBlock } from './reasoning-block'
import { SubagentList } from './subagent-list'
import { TodoList } from './todo-list'

// The composer's draft is state ABOVE the transcript, so every keystroke re-renders the conversation view. Each of
// these items renders markdown through the full unified pipeline (remark-gfm → rehype-raw → sanitize), and when
// they were plain function components a single keystroke re-parsed the whole transcript — measured at ~17ms for a
// 5-turn conversation and ~46ms for 20 turns in node alone, before the browser's own reconciliation, which is what
// made typing in the panel drop frames. React can only skip that work if the component is memoized, so that is the
// invariant: a transcript item is memoized, always. A new item kind belongs in this list too.

const MEMO = Symbol.for('react.memo')

const ITEMS = {
  MessageRow,
  ReasoningBlock,
  ContextBlock,
  TodoList,
  SubagentList,
  DelegationCard,
  // The list itself is a memo boundary too: the composer draft and the live streaming tail re-render the
  // conversation view on every keystroke/SSE delta, and without this boundary each of those re-reconciles
  // all N rows (N element allocations + prop compares) even though every row bails out.
  TranscriptList,
}

describe('agent chat transcript items', () => {
  it('lets React skip a settled item when only the composer draft changed', () => {
    for (const [name, item] of Object.entries(ITEMS))
      expect((item as { $$typeof?: symbol }).$$typeof, name).toBe(MEMO)
  })
})
