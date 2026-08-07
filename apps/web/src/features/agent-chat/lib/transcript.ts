import { z } from 'zod'

import type { AgentMessage } from '@/entities/agent-session'
import type { AnalysisArtifact } from '@/entities/analysis-artifact'

// Fold the flat message transcript into render items. The agent loop emits MANY assistant turns (one per model call),
// each with a little text and/or a burst of tool calls — rendering all of that makes the panel a long noisy stack.
// So we distill: assistant TEXT and USER turns render as message rows; reasoning surfaces as its own foldable block;
// a `write_todos` call surfaces as a dedicated checklist; spawn_agent/spawn_teammate calls surface as a live
// sub-agent activity card (parallel/background delegation made visible, Claude Code style). Plain tool calls/results
// are deliberately NOT rendered — the conversation shows what the agent says and delegates, not its plumbing.

// 작업목록은 전체 덮어쓰기 시맨틱(write_todos)이므로, 같은 목록의 새 스냅샷이 오면 처음 등장한 그 자리에서
// 내용만 교체한다(위치·id 모두 안정 — 갱신마다 목록이 바닥으로 이동하면 위 내용이 통째로 당겨지며 스크롤이
// 튀고, id 가 바뀌면 React 가 리마운트해 스피너·문구가 깜빡인다). 내용이 하나도 겹치지 않으면 "새 목록"으로
// 보고 이전 것을 이력으로 보존한다.
const WRITE_TODOS_TOOL = 'write_todos'
const SPAWN_AGENT_TOOL = 'spawn_agent'
const CREATE_SANDBOX_TOOL = 'create_sandbox'
const SPAWN_TEAMMATE_TOOL = 'spawn_teammate'

// 커널(@everdict/agent-runtime loop.ts / spawn-tool.ts)의 고정 문구와 짝을 이루는 파서들 — 백그라운드 서브에이전트의
// 진행 상태는 별도 이벤트가 아니라 이 레코드 문구로 흘러오므로, 커널 쪽 문구가 바뀌면 여기도 함께 바뀌어야 한다.
const BG_RESULT_PREFIX = '[Background sub-agent '
const BG_RESULT_HEAD = /^\[Background sub-agent (\S+) (finished|failed)\]\n?/
const BG_LAUNCH_ACK = /Sub-agent (\S+) launched in the background/
// 메일박스가 주입한 컨텍스트 턴의 attribution 접두사 (apps/agent agent-mailbox.ts renderEnvelope와 짝) — 팀메이트
// 메시지·플랫폼 이벤트는 유저가 쓴 말이 아니므로 말풍선이 아니라 접힌 컨텍스트 블록으로 렌더한다.
const TEAMMATE_MSG_HEAD = /^\[Message from teammate ([^\]]*)\]\n?/
const EVENT_MSG_HEAD = /^\[Everdict event(?: — ([^\]]*))?\]\n?/

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

// 한 번의 위임. sessionRunId 가 있어야 카드가 그 대화를 붙어서 볼 수 있다 — 도구 결과(RunRecord)에서 온다.
// 결과가 없으면(아직 실행 중) running, 결과가 RunRecord 로 안 읽히면(권한 거부·오류) failed.
export interface DelegationView {
  id: string
  profileId: string
  goal: string
  sessionRunId?: string
  status: 'running' | 'open' | 'failed'
  detail?: string
}

export type TranscriptItem =
  | { kind: 'message'; message: AgentMessage } // a user turn OR an assistant turn's text
  | { kind: 'reasoning'; id: string; text: string } // an assistant turn's reasoning / thinking
  | { kind: 'todos'; id: string; todos: TodoItemView[] } // the current write_todos checklist
  | { kind: 'agents'; id: string; agents: SubagentView[] } // a burst of delegated sub-agents / teammates
  // context injected by the mailbox (a teammate's message / a platform event) — folded like reasoning, hidden by default
  | { kind: 'context'; id: string; source: 'teammate' | 'event'; sender?: string; text: string }
  // an analysis artifact (chart/table/report) the agent emitted this conversation — rendered as a card in place
  | { kind: 'artifact'; id: string; artifact: AnalysisArtifact }
  // 에이전트가 일을 맡긴 위임 — 그 세션의 대화를 카드 안에서 그대로 펼쳐 본다(위임의 위임 가시성)
  | { kind: 'delegation'; id: string; delegation: DelegationView }

// Parse a write_todos tool-call argument string into checklist items. Best-effort: a malformed payload yields [].
export function parseTodosArg(raw: string): TodoItemView[] {
  try {
    const parsed = todosArgsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

// create_sandbox 호출 한 건을 위임 뷰로. 인자에서 프로필/목표를, 도구 결과(RunRecord JSON)에서 세션 run id 를
// 읽는다. 둘 다 best-effort — 손상되거나 거부 문자열이면 실패로 표시하고 카드가 그 사실을 말한다(조용히 사라지지
// 않는다). 권한 모드가 default/plan 이면 결과는 RunRecord 가 아니라 거부 문구라서 이 분기가 실제로 쓰인다.
export function parseDelegationEntry(
  tc: { id: string; name: string; arguments: string },
  result: string | undefined
): DelegationView | undefined {
  let profileId = ''
  let goal = ''
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>
    const profile = args.profile
    if (profile === null || typeof profile !== 'object') return undefined // 위임이 아닌 일반 샌드박스 부팅
    profileId =
      typeof (profile as Record<string, unknown>).id === 'string'
        ? String((profile as Record<string, unknown>).id)
        : ''
    const brief = args.brief
    if (
      brief !== null &&
      typeof brief === 'object' &&
      typeof (brief as Record<string, unknown>).goal === 'string'
    )
      goal = String((brief as Record<string, unknown>).goal)
  } catch {
    return undefined // 인자를 못 읽으면 위임인지조차 알 수 없다
  }
  if (result === undefined) return { id: tc.id, profileId, goal, status: 'running' }
  try {
    const record = JSON.parse(result) as Record<string, unknown>
    const runId = typeof record.id === 'string' ? record.id : undefined
    if (runId === undefined) throw new Error('no run id')
    return { id: tc.id, profileId, goal, sessionRunId: runId, status: 'open' }
  } catch {
    return { id: tc.id, profileId, goal, status: 'failed', detail: result.slice(0, 400) }
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

  const base = {
    id: tc.id,
    kind: 'subagent' as const,
    task,
    ...(type !== undefined ? { type } : {}),
  }
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

// Artifacts interleave by time: each renders after the LAST message created at or before it (an artifact is born
// between its tool call and the next persisted turn), so a chart appears where the conversation produced it.
function artifactsByAnchor(
  messages: AgentMessage[],
  artifacts: AnalysisArtifact[]
): Map<number, AnalysisArtifact[]> {
  const byAnchor = new Map<number, AnalysisArtifact[]>()
  for (const artifact of artifacts) {
    let anchor = -1
    for (let i = 0; i < messages.length; i++) {
      const at = messages[i]?.createdAt
      if (at !== undefined && at <= artifact.createdAt) anchor = i
    }
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), artifact])
  }
  return byAnchor
}

export function buildTranscript(
  messages: AgentMessage[],
  artifacts: AnalysisArtifact[] = []
): TranscriptItem[] {
  // spawn 계열 도구의 결과만 call id로 되짚는다 — 일반 도구 결과는 렌더에 쓰지 않는다.
  const spawnCallIds = new Set<string>()
  for (const m of messages)
    for (const tc of m.toolCalls ?? [])
      if (tc.name === SPAWN_AGENT_TOOL || tc.name === SPAWN_TEAMMATE_TOOL) spawnCallIds.add(tc.id)
      else if (tc.name === CREATE_SANDBOX_TOOL) spawnCallIds.add(tc.id) // 위임 세션 id 는 결과에만 있다
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

  const processMessage = (m: AgentMessage): void => {
    if (m.role === 'tool') return // tool results are folded into the activity card / not rendered
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
        return
      }
      // 메일박스 주입 컨텍스트(팀메이트 메시지·플랫폼 이벤트) — 유저 발화가 아니므로 접힌 컨텍스트 블록으로.
      // 열린 활동 카드는 쪼개지 않는다(reasoning과 같은 취급 — 대화 흐름을 끊는 건 진짜 유저/어시스턴트 발화뿐).
      const teammate = TEAMMATE_MSG_HEAD.exec(m.content)
      if (teammate) {
        const sender = (teammate[1] ?? '').trim()
        items.push({
          kind: 'context',
          id: m.id,
          source: 'teammate',
          ...(sender.length > 0 ? { sender } : {}),
          text: m.content.slice(teammate[0].length),
        })
        return
      }
      const event = EVENT_MSG_HEAD.exec(m.content)
      if (event) {
        const sender = (event[1] ?? '').trim()
        items.push({
          kind: 'context',
          id: m.id,
          source: 'event',
          ...(sender.length > 0 ? { sender } : {}),
          text: m.content.slice(event[0].length),
        })
        return
      }
      agentBuf = null
      items.push({ kind: 'message', message: m })
      return
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
        // 항목 내용이 하나라도 겹치면 같은 목록의 갱신 — 처음 자리의 스냅샷을 제자리에서 교체한다.
        // id 는 첫 스냅샷의 것을 유지해 React key 가 안정되게 한다(리마운트·스크롤 점프 방지).
        const sameList = todos.some((td) => lastTodos.some((prev) => prev.content === td.content))
        const anchor = sameList && lastTodosAt >= 0 ? items[lastTodosAt] : undefined
        if (anchor !== undefined && anchor.kind === 'todos') {
          items[lastTodosAt] = { kind: 'todos', id: anchor.id, todos }
        } else {
          items.push({ kind: 'todos', id: tc.id, todos })
          lastTodosAt = items.length - 1
        }
        lastTodos = todos
      } else if (tc.name === CREATE_SANDBOX_TOOL) {
        const delegation = parseDelegationEntry(tc, resultByCallId.get(tc.id))
        if (delegation === undefined) continue // 프로필 없는 샌드박스 부팅은 위임이 아니다 — 카드도 없다
        agentBuf = null // 위임은 결과물 쪽 — 열려 있던 활동 카드를 닫는다(아티팩트와 같은 규칙)
        items.push({ kind: 'delegation', id: tc.id, delegation })
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

  // Emitted artifacts render in place (after the last message at or before their creation) — they close an
  // open activity card exactly like assistant text would (the card shows delegation, the artifact is output).
  const anchored = artifactsByAnchor(messages, artifacts)
  const pushArtifacts = (anchor: number): void => {
    for (const artifact of anchored.get(anchor) ?? []) {
      agentBuf = null
      items.push({ kind: 'artifact', id: artifact.id, artifact })
    }
  }
  pushArtifacts(-1)
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]
    if (m !== undefined) processMessage(m)
    pushArtifacts(mi)
  }
  return items
}
