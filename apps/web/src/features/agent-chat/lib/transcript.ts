import { z } from 'zod'

import type { AgentMessage } from '@/entities/agent-session'
import type { AnalysisArtifact } from '@/entities/analysis-artifact'

// Fold the flat message transcript into render items. The agent loop emits MANY assistant turns (one per model call),
// each with a little text and/or a burst of tool calls — rendering all of that makes the panel a long noisy stack.
// So we distill: assistant TEXT and USER turns render as message rows; reasoning surfaces as its own foldable block;
// a `write_todos` call surfaces as a dedicated checklist; spawn_agent/spawn_teammate calls surface as a live
// sub-agent activity card (parallel/background delegation made visible, Claude Code style). Plain tool calls/results
// are deliberately NOT rendered — the conversation shows what the agent says and delegates, not its plumbing.

// A todo list has whole-overwrite semantics (write_todos), so when a new snapshot of the SAME list arrives only its content is replaced,
// in the place it first appeared (both position and id stay stable — a list that moves to the bottom on every update drags everything above
// it and the scroll jumps, and a changed id makes React remount so spinners and text flicker). With no item in common at all it is treated
// as a NEW list and the previous one is preserved as history.
const WRITE_TODOS_TOOL = 'write_todos'
const SPAWN_AGENT_TOOL = 'spawn_agent'
const CREATE_SANDBOX_TOOL = 'create_sandbox'
const SPAWN_TEAMMATE_TOOL = 'spawn_teammate'

// The parsers paired with the kernel's fixed wording (@everdict/agent-runtime loop.ts / spawn-tool.ts) — a background sub-agent's progress
// arrives as this record TEXT rather than as its own event, so wording changed on the kernel side has to change here too.
const BG_RESULT_PREFIX = '[Background sub-agent '
const BG_RESULT_HEAD = /^\[Background sub-agent (\S+) (finished|failed)\]\n?/
const BG_LAUNCH_ACK = /Sub-agent (\S+) launched in the background/
// The attribution prefix of a context turn injected by the mailbox (paired with apps/agent agent-mailbox.ts renderEnvelope) — a teammate
// message or a platform event is not something the USER said, so it renders as a folded context block rather than a speech bubble.
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

// One delegation. A sessionRunId is what lets the card attach to and watch that conversation — it comes from the tool result (RunRecord).
// No result (still running) is `running`; a result that does not read as a RunRecord (permission denied, an error) is `failed`.
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
  // The delegation the agent handed work to — its session's conversation is expanded inside the card (visibility into a delegation's delegation)
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

// One create_sandbox call as a delegation view. The profile and goal come from the arguments and the session run id from the tool result
// (RunRecord JSON). Both are best-effort — a corrupted or refusal string is marked failed and the card SAYS so (it does not disappear
// quietly). In default/plan permission mode the result is a refusal message rather than a RunRecord, so this branch is genuinely used.
export function parseDelegationEntry(
  tc: { id: string; name: string; arguments: string },
  result: string | undefined
): DelegationView | undefined {
  let profileId = ''
  let goal = ''
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>
    const profile = args.profile
    if (profile === null || typeof profile !== 'object') return undefined // an ordinary sandbox boot, not a delegation
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
    return undefined // unreadable arguments mean we cannot even tell whether it was a delegation
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
    // Corrupted arguments — shown as an empty task
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
    // The kernel's bg id comes from the launch ack; completion is announced by the [Background sub-agent …] user turn injected later.
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
  // Only the results of the spawn-family tools are traced back by call id — ordinary tool results are not used in the render.
  const spawnCallIds = new Set<string>()
  for (const m of messages)
    for (const tc of m.toolCalls ?? [])
      if (tc.name === SPAWN_AGENT_TOOL || tc.name === SPAWN_TEAMMATE_TOOL) spawnCallIds.add(tc.id)
      else if (tc.name === CREATE_SANDBOX_TOOL) spawnCallIds.add(tc.id) // a delegation session id exists only on the result
  const resultByCallId = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.toolCallId !== undefined && spawnCallIds.has(m.toolCallId))
      resultByCallId.set(m.toolCallId, m.content)

  const items: TranscriptItem[] = []
  let lastTodos: TodoItemView[] = []
  let lastTodosAt = -1
  // A reference to the entries of the OPEN activity card — it closes on a user turn or assistant text (reasoning and todos do not split a card).
  let agentBuf: SubagentView[] | null = null
  // Background sub-agents not finished yet: kernel bg id → card entry. A bg id is REUSED across runs (bg-1…), so a completion turn is paired
  // in order with the outstanding launches at the moment it arrives.
  const pendingBg = new Map<string, SubagentView>()

  const processMessage = (m: AgentMessage): void => {
    if (m.role === 'tool') return // tool results are folded into the activity card / not rendered
    if (m.role === 'user') {
      // A background result turn injected by the kernel — folded into the card's state and summary, never rendered as a bubble.
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
      // Mailbox-injected context (a teammate message, a platform event) — not the user speaking, so a folded context block.
      // It does not split an open activity card (treated like reasoning — only a real user or assistant utterance breaks the conversation flow).
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
        // Any item in common means this is an UPDATE of the same list — the first snapshot's position is replaced in place.
        // The id is kept from the first snapshot so the React key stays stable (no remount, no scroll jump).
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
        if (delegation === undefined) continue // a sandbox boot with no profile is not a delegation — and gets no card
        agentBuf = null // a delegation is on the OUTPUT side — it closes an open activity card (the same rule as an artifact)
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
