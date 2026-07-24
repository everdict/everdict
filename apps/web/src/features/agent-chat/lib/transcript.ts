import { z } from 'zod'

import type { AgentMessage } from '@/entities/agent-session'

// Fold the flat message transcript into render items. The agent loop emits MANY assistant turns (one per model call),
// each with a little text and/or a burst of tool calls — rendering each as its own avatar'd row makes the panel a long
// noisy stack. So we group: assistant TEXT and USER turns render as message rows; consecutive tool calls collapse into
// one ToolGroup; a `write_todos` call surfaces as a dedicated checklist; reasoning surfaces as its own foldable block.
// The natural per-turn order is reasoning → text → tools, and text/todos/user flush any pending tool group.

// 도구가 반환한 결과(role:'tool' 레코드)는 assistant 의 tool_call id 로 되짚어 그룹 카드 안에서 함께 보여준다.
const WRITE_TODOS_TOOL = 'write_todos'

const todoItemSchema = z.object({
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type TodoItemView = z.infer<typeof todoItemSchema>
const todosArgsSchema = z.object({ todos: z.array(todoItemSchema) })

export interface ToolCallView {
  id: string
  name: string
  args: string
  result?: string
}

export type TranscriptItem =
  | { kind: 'message'; message: AgentMessage } // a user turn OR an assistant turn's text
  | { kind: 'reasoning'; id: string; text: string } // an assistant turn's reasoning / thinking
  | { kind: 'todos'; id: string; todos: TodoItemView[] } // a write_todos snapshot
  | { kind: 'tools'; id: string; calls: ToolCallView[] } // a run of consecutive tool calls, grouped

// Parse a write_todos tool-call argument string into checklist items. Best-effort: a malformed payload yields [].
export function parseTodosArg(raw: string): TodoItemView[] {
  try {
    const parsed = todosArgsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

function todosKey(todos: TodoItemView[]): string {
  return todos.map((t) => `${t.status}:${t.content}`).join('|')
}

export function buildTranscript(messages: AgentMessage[]): TranscriptItem[] {
  const resultByCallId = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.toolCallId) resultByCallId.set(m.toolCallId, m.content)

  const items: TranscriptItem[] = []
  let toolBuf: ToolCallView[] = []
  let anchorId = ''
  const flushTools = (): void => {
    if (toolBuf.length === 0) return
    items.push({ kind: 'tools', id: anchorId, calls: toolBuf })
    toolBuf = []
    anchorId = ''
  }
  let lastTodosKey = ''

  for (const m of messages) {
    if (m.role === 'tool') continue // results are folded into the tool group by call id
    if (m.role === 'user') {
      flushTools()
      items.push({ kind: 'message', message: m })
      continue
    }
    // assistant turn — reasoning, then text, then this turn's tool calls (each flushes what precedes it)
    if (m.reasoning !== undefined && m.reasoning.trim().length > 0) {
      flushTools()
      items.push({ kind: 'reasoning', id: `${m.id}:reasoning`, text: m.reasoning })
    }
    if (m.content.trim().length > 0) {
      flushTools()
      items.push({ kind: 'message', message: m })
    }
    for (const tc of m.toolCalls ?? []) {
      if (tc.name === WRITE_TODOS_TOOL) {
        flushTools()
        const todos = parseTodosArg(tc.arguments)
        // Skip a snapshot identical to the last one shown (the model re-sending an unchanged list adds no signal).
        const key = todosKey(todos)
        if (key === lastTodosKey) continue
        lastTodosKey = key
        items.push({ kind: 'todos', id: tc.id, todos })
      } else {
        if (anchorId === '') anchorId = tc.id
        const result = resultByCallId.get(tc.id)
        toolBuf.push({ id: tc.id, name: tc.name, args: tc.arguments, ...(result !== undefined ? { result } : {}) })
      }
    }
  }
  flushTools()
  return items
}
