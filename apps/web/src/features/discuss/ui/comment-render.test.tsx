import { describe, expect, it } from 'vitest'

import { CommentCard } from './comment-thread'

// While an agent is answering, the thread polls itself every 2.5s and replaces the whole list — the server
// rebuilds it from rows, so every comment arrives as a NEW object even when nothing about it changed. Each card
// renders markdown through the full unified pipeline (remark-gfm → rehype-raw → sanitize), measured at ~5.6ms per
// body in node alone (before the browser's own reconciliation): a 20-comment thread spends ~112ms per tick
// re-parsing text that did not change, and the page is frozen for it. React can only skip that work if the card is
// memoized AND the comparison looks at the fields rather than the object identity the poll cannot preserve.
// Same invariant, same reason as the agent chat's transcript items (features/agent-chat/ui/transcript-render.test.tsx).

const MEMO = Symbol.for('react.memo')

describe('comment thread rendering', () => {
  it('lets React skip a comment the poll did not actually change', () => {
    expect((CommentCard as { $$typeof?: symbol }).$$typeof).toBe(MEMO)
    // A bare memo would be useless here — the poll hands over fresh objects, so the card must compare by value.
    expect((CommentCard as { compare?: unknown }).compare).toBeTypeOf('function')
  })

  it('treats a comment with identical fields as unchanged, and a live agent turn as changed', () => {
    const compare = (CommentCard as unknown as { compare: (a: unknown, b: unknown) => boolean })
      .compare
    const mentionables = [{ subject: 's', name: 'Dana' }]
    const base = {
      id: 'c1',
      actor: { name: 'Dana', known: true },
      body: 'hello',
      at: '2026-08-03T00:00:00Z',
      canDelete: false,
    }

    expect(compare({ item: { ...base }, mentionables }, { item: { ...base }, mentionables })).toBe(
      true
    )
    expect(
      compare(
        { item: { ...base }, mentionables },
        { item: { ...base, body: 'edited' }, mentionables }
      )
    ).toBe(false)
    // The agent's live line changes without the body changing — the card must still re-render for it.
    expect(
      compare(
        { item: { ...base, isAgent: true, agentActivity: 'thinking' }, mentionables },
        { item: { ...base, isAgent: true, agentActivity: 'tool:read_file' }, mentionables }
      )
    ).toBe(false)
  })
})
