import { z } from 'zod'

import type { AgentMessage } from '@/entities/agent-session'

// Fold the flat message transcript into render items. The agent loop emits MANY assistant turns (one per model call),
// each with a little text and/or a burst of tool calls — rendering all of that makes the panel a long noisy stack.
// So we distill: assistant TEXT and USER turns render as message rows; reasoning surfaces as its own foldable block;
// a `write_todos` call surfaces as a dedicated checklist; spawn_agent/spawn_teammate calls surface as a live
// sub-agent activity card (parallel/background delegation made visible, Claude Code style). Plain tool calls/results
// are deliberately NOT rendered — the conversation shows what the agent says and delegates, not its plumbing.

// 작업목록은 전체 덮어쓰기 시맨틱(write_todos)이므로, 같은 목록의 새 스냅샷이 오면 이전 항목을 제거하고
// 최신 스냅샷 하나만 최신 위치에 남긴다. 내용이 하나도 겹치지 않으면 "새 목록"으로 보고 이전 것을 이력으로 보존한다.
const WRITE_TODOS_TOOL = 'write_todos'
const SPAWN_AGENT_TOOL = 'spawn_agent'
const SPAWN_TEAMMATE_TOOL = 'spawn_teammate'

// 커널(@everdict/agent-runtime loop.ts / spawn-tool.ts)의 고정 문구와 짝을 이루는 파서들 — 백그라운드 서브에이전트의
// 진행 상태는 별도 이벤트가 아니라 이 레코드 문구로 흘러오므로, 커널 쪽 문구가 바뀌면 여기도 함께 바뀌어야 한다.
const BG_RESULT_PREFIX = '[Background sub-agent '
const BG_RESULT_HEAD = /^\[Background sub-agent (\S+) (finished|failed)\]\n?/
const BG_LAUNCH_ACK = /Sub-agent (\S+) launched in the background/

const todoItemSchema = z.object({
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type TodoItemView = z.infer<typeof todoItemSchema>
const todosArgsSchema = z.object({ todos: z.array(todoItemSchema) })

// One delegated agent in the activity card: a spawn_agent sub-task (foreground or background) or a spawned teammate.
export interface SubagentView {
  id: string // the spawn tool-call id
  kind: 'subagent' | 'teammate'
  task: string
  type?: string // spawn_agent subagent_type, when picked
  background: boolean
  status: 'running' | 'done' | 'failed'
  summary?: string // the sub-agent's returned findings / the spawn acknowledgement
}

export type TranscriptItem =
  | { kind: 'message'; message: AgentMessage } // a user turn OR an assistant turn's text
  | { kind: 'reasoning'; id: string; text: string } // an assistant turn's reasoning / thinking
  | { kind: 'todos'; id: string; todos: TodoItemView[] } // the current write_todos checklist
  | { kind: 'agents'; id: string; agents: SubagentView[] } // a burst of delegated sub-agents / teammates

// Parse a write_todos tool-call argument string into checklist items. Best-effort: a malformed payload yields [].
export function parseTodosArg(raw: string): TodoItemView[] {
  try {
    const parsed = todosArgsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

function parseSpawnEntry(
  tc: { id: string; name: string; arguments: string },
  result: string | undefined
): { entry: SubagentView; bgId?: string } {
  let task = ''
  let type: string | undefined
  let background = false
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>
    if (tc.name === SPAWN_TEAMMATE_TOOL) {
      const name = typeof args.name === 'string' ? args.name : ''
      const standing = typeof args.task === 'string' ? args.task : ''
      task = name.length > 0 && standing.length > 0 ? `${name} — ${standing}` : name + standing
    } else {
      task = typeof args.task === 'string' ? args.task : ''
      if (typeof args.subagent_type === 'string') type = args.subagent_type
      background = args.run_in_background === true
    }
  } catch {
    // 손상된 인자 — 빈 태스크로 표시
  }

  if (tc.name === SPAWN_TEAMMATE_TOOL) {
    const failed =
      result !== undefined &&
      (result.startsWith('Could not spawn teammate') || result.startsWith('spawn_teammate:'))
    return {
      entry: {
        id: tc.id,
        kind: 'teammate',
        task,
        background: true,
        status: result === undefined ? 'running' : failed ? 'failed' : 'done',
        ...(result !== undefined ? { summary: result } : {}),
      },
    }
  }

  const base = { id: tc.id, kind: 'subagent' as const, task, ...(type !== undefined ? { type } : {}) }
  if (background) {
    // 런치 ack에서 커널의 bg id를 얻는다; 완료는 나중에 주입되는 [Background sub-agent …] user 턴이 알려준다.
    const ack = result !== undefined ? BG_LAUNCH_ACK.exec(result) : null
    if (ack) return { entry: { ...base, background: true, status: 'running' }, bgId: ack[1] }
    return {
      entry: {
        ...base,
        background: true,
        status: result === undefined ? 'running' : 'failed',
        ...(result !== undefined ? { summary: result } : {}),
      },
    }
  }
  return {
    entry: {
      ...base,
      background: false,
      status: result === undefined ? 'running' : 'done',
      ...(result !== undefined ? { summary: result } : {}),
    },
  }
}

export function buildTranscript(messages: AgentMessage[]): TranscriptItem[] {
  // spawn 계열 도구의 결과만 call id로 되짚는다 — 일반 도구 결과는 렌더에 쓰지 않는다.
  const spawnCallIds = new Set<string>()
  for (const m of messages)
    for (const tc of m.toolCalls ?? [])
      if (tc.name === SPAWN_AGENT_TOOL || tc.name === SPAWN_TEAMMATE_TOOL) spawnCallIds.add(tc.id)
  const resultByCallId = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.toolCallId !== undefined && spawnCallIds.has(m.toolCallId))
      resultByCallId.set(m.toolCallId, m.content)

  const items: TranscriptItem[] = []
  let lastTodos: TodoItemView[] = []
  let lastTodosAt = -1
  // 열려있는 활동 카드의 entries 참조 — user 턴/assistant 텍스트가 나오면 닫힌다(reasoning·todos는 카드를 쪼개지 않음).
  let agentBuf: SubagentView[] | null = null
  // 아직 완료 안 된 백그라운드 서브에이전트: 커널 bg id → 카드 엔트리. bg id는 런마다 재사용되므로(bg-1…)
  // 완료 턴을 만나는 시점의 미해결 런치와 순서대로 짝지어야 한다.
  const pendingBg = new Map<string, SubagentView>()

  for (const m of messages) {
    if (m.role === 'tool') continue // tool results are folded into the activity card / not rendered
    if (m.role === 'user') {
      // 커널이 주입한 백그라운드 결과 턴 — 카드의 상태·요약으로 접고, 말풍선으로는 렌더하지 않는다.
      if (m.content.startsWith(BG_RESULT_PREFIX)) {
        for (const block of m.content.split(/(?=\[Background sub-agent )/)) {
          const head = BG_RESULT_HEAD.exec(block)
          if (!head) continue
          const entry = pendingBg.get(head[1])
          if (!entry) continue
          entry.status = head[2] === 'finished' ? 'done' : 'failed'
          const summary = block.slice(head[0].length).trim()
          if (summary.length > 0) entry.summary = summary
          pendingBg.delete(head[1])
        }
        continue
      }
      agentBuf = null
      items.push({ kind: 'message', message: m })
      continue
    }
    // assistant turn — reasoning, then text, then this turn's todo/spawn calls (plain tool calls are skipped)
    if (m.reasoning !== undefined && m.reasoning.trim().length > 0)
      items.push({ kind: 'reasoning', id: `${m.id}:reasoning`, text: m.reasoning })
    if (m.content.trim().length > 0) {
      agentBuf = null
      items.push({ kind: 'message', message: m })
    }
    for (const tc of m.toolCalls ?? []) {
      if (tc.name === WRITE_TODOS_TOOL) {
        const todos = parseTodosArg(tc.arguments)
        if (todos.length === 0) continue
        // 항목 내용이 하나라도 겹치면 같은 목록의 갱신 — 이전 스냅샷을 지우고 최신 것만 남긴다.
        // (활동 카드는 items 인덱스가 아니라 entries 배열 참조로 이어지므로 splice에 안전하다.)
        const sameList = todos.some((td) => lastTodos.some((prev) => prev.content === td.content))
        if (sameList && lastTodosAt >= 0) items.splice(lastTodosAt, 1)
        items.push({ kind: 'todos', id: tc.id, todos })
        lastTodosAt = items.length - 1
        lastTodos = todos
      } else if (tc.name === SPAWN_AGENT_TOOL || tc.name === SPAWN_TEAMMATE_TOOL) {
        const { entry, bgId } = parseSpawnEntry(tc, resultByCallId.get(tc.id))
        if (bgId !== undefined) pendingBg.set(bgId, entry)
        if (agentBuf === null) {
          agentBuf = []
          items.push({ kind: 'agents', id: tc.id, agents: agentBuf })
        }
        agentBuf.push(entry)
      }
    }
  }
  return items
}
