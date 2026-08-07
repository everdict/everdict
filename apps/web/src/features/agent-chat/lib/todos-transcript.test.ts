import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '@/entities/agent-session'

import { buildTranscript } from './transcript'

// write_todos has whole-list overwrite semantics, and the panel folds every snapshot of the SAME list into ONE
// checklist item. That item must stay put: if an update relocated it to the transcript's tail, everything between
// its old position and the bottom would shift up mid-stream (the scroll-jump flicker), and a fresh React key would
// remount the checklist on every update (the spinner/label blink). Regression for both: position AND id are stable.

let seq = 0
const assistantWithTodos = (
  callId: string,
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[]
): AgentMessage => ({
  id: `m-${callId}`,
  tenant: 'default',
  sessionId: 's-1',
  seq: seq++,
  role: 'assistant',
  content: '',
  toolCalls: [{ id: callId, name: 'write_todos', arguments: JSON.stringify({ todos }) }],
  createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
})

const assistantText = (id: string, content: string): AgentMessage => ({
  id,
  tenant: 'default',
  sessionId: 's-1',
  seq: seq++,
  role: 'assistant',
  content,
  createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
})

describe('buildTranscript — write_todos folding', () => {
  it('an update to the same list replaces the checklist IN PLACE, keeping its position and id stable', () => {
    const items = buildTranscript([
      assistantWithTodos('call-1', [
        { content: 'list harnesses', status: 'in_progress', activeForm: 'Listing harnesses' },
        { content: 'list datasets', status: 'pending' },
      ]),
      assistantText('m-text', 'Working through the harnesses now.'),
      assistantWithTodos('call-2', [
        { content: 'list harnesses', status: 'completed' },
        { content: 'list datasets', status: 'in_progress', activeForm: 'Listing datasets' },
      ]),
    ])

    const todosItems = items.filter((i) => i.kind === 'todos')
    expect(todosItems).toHaveLength(1)
    // Position: the checklist stays where it first appeared — BEFORE the text that streamed after it.
    expect(items.findIndex((i) => i.kind === 'todos')).toBeLessThan(
      items.findIndex((i) => i.kind === 'message')
    )
    // Identity: the first snapshot's id survives the update, so the React key never changes.
    expect(todosItems[0]?.id).toBe('call-1')
    // Content: the item carries the LATEST snapshot.
    expect(todosItems[0]?.todos).toEqual([
      { content: 'list harnesses', status: 'completed' },
      { content: 'list datasets', status: 'in_progress', activeForm: 'Listing datasets' },
    ])
  })

  it('a snapshot sharing no item with the previous list is a NEW checklist — the old one is kept as history', () => {
    const items = buildTranscript([
      assistantWithTodos('call-1', [{ content: 'old plan step', status: 'completed' }]),
      assistantWithTodos('call-2', [{ content: 'entirely new plan step', status: 'pending' }]),
    ])

    const todosItems = items.filter((i) => i.kind === 'todos')
    expect(todosItems).toHaveLength(2)
    expect(todosItems[0]?.id).toBe('call-1')
    expect(todosItems[1]?.id).toBe('call-2')
  })

  it('updates keep folding into the original position across several snapshots', () => {
    const items = buildTranscript([
      assistantWithTodos('call-1', [
        { content: 'step a', status: 'in_progress' },
        { content: 'step b', status: 'pending' },
      ]),
      assistantWithTodos('call-2', [
        { content: 'step a', status: 'completed' },
        { content: 'step b', status: 'in_progress' },
      ]),
      assistantWithTodos('call-3', [
        { content: 'step a', status: 'completed' },
        { content: 'step b', status: 'completed' },
      ]),
    ])

    const todosItems = items.filter((i) => i.kind === 'todos')
    expect(todosItems).toHaveLength(1)
    expect(todosItems[0]?.id).toBe('call-1')
    expect(todosItems[0]?.todos.every((t) => t.status === 'completed')).toBe(true)
  })
})
