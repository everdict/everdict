import { z } from 'zod'

import type { AgentMessage } from '@/entities/agent-session'

// Fold the flat message transcript into render items. The agent loop emits MANY assistant turns (one per model call),
// each with a little text and/or a burst of tool calls — rendering all of that makes the panel a long noisy stack.
// So we distill: assistant TEXT and USER turns render as message rows; reasoning surfaces as its own foldable block;
// a `write_todos` call surfaces as a dedicated checklist. Plain tool calls/results are deliberately NOT rendered —
// the conversation shows what the agent says, not its plumbing.

// 작업목록은 전체 덮어쓰기 시맨틱(write_todos)이므로, 같은 목록의 새 스냅샷이 오면 이전 항목을 제거하고
// 최신 스냅샷 하나만 최신 위치에 남긴다. 내용이 하나도 겹치지 않으면 "새 목록"으로 보고 이전 것을 이력으로 보존한다.
const WRITE_TODOS_TOOL = 'write_todos'

const todoItemSchema = z.object({
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type TodoItemView = z.infer<typeof todoItemSchema>
const todosArgsSchema = z.object({ todos: z.array(todoItemSchema) })

export type TranscriptItem =
  | { kind: 'message'; message: AgentMessage } // a user turn OR an assistant turn's text
  | { kind: 'reasoning'; id: string; text: string } // an assistant turn's reasoning / thinking
  | { kind: 'todos'; id: string; todos: TodoItemView[] } // the current write_todos checklist

// Parse a write_todos tool-call argument string into checklist items. Best-effort: a malformed payload yields [].
export function parseTodosArg(raw: string): TodoItemView[] {
  try {
    const parsed = todosArgsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

export function buildTranscript(messages: AgentMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let lastTodos: TodoItemView[] = []
  let lastTodosAt = -1

  for (const m of messages) {
    if (m.role === 'tool') continue // tool results are not rendered
    if (m.role === 'user') {
      items.push({ kind: 'message', message: m })
      continue
    }
    // assistant turn — reasoning, then text, then this turn's todo snapshot (plain tool calls are skipped)
    if (m.reasoning !== undefined && m.reasoning.trim().length > 0)
      items.push({ kind: 'reasoning', id: `${m.id}:reasoning`, text: m.reasoning })
    if (m.content.trim().length > 0) items.push({ kind: 'message', message: m })
    for (const tc of m.toolCalls ?? []) {
      if (tc.name !== WRITE_TODOS_TOOL) continue
      const todos = parseTodosArg(tc.arguments)
      if (todos.length === 0) continue
      // 항목 내용이 하나라도 겹치면 같은 목록의 갱신 — 이전 스냅샷을 지우고 최신 것만 남긴다.
      const sameList = todos.some((td) => lastTodos.some((prev) => prev.content === td.content))
      if (sameList && lastTodosAt >= 0) items.splice(lastTodosAt, 1)
      items.push({ kind: 'todos', id: tc.id, todos })
      lastTodosAt = items.length - 1
      lastTodos = todos
    }
  }
  return items
}
