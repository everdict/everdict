import { type ChatMessage, runAgentLoop } from "@everdict/agent-runtime";
import type { TraceEvent } from "@everdict/contracts";
import { renderActivationPrompt } from "./agent-activation.js";
import { contentToString, extractToolCalls } from "./chat.js";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelByIdResolver, ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";
import type { ProfileResolver } from "./profile.js";

// Agent try-drive (docs/architecture/agent-automation.md B3) — the crafting crux: fire a (replayed or hand-built)
// platform event at an agent BEFORE enabling it, in SHADOW mode, and watch what it would do. Read tools run for
// real against the workspace's data (the caller's own bearer bounds them); every MUTATION is captured as a
// would-have-done intent and DENIED — a try can never have side effects. Stateless: no session, nothing persisted.

export interface AgentTryEvent {
  kind: string;
  message: string;
  subject?: { type: string; id: string };
  payload?: Record<string, unknown>;
}

export interface AgentTryMessage {
  role: "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; arguments: string }[];
  toolCallId?: string;
}

export interface AgentTryResult {
  messages: AgentTryMessage[];
  // The mutations the agent WOULD have made (tool name + arguments) — shadow mode's whole point.
  wouldHave: { name: string; input: unknown }[];
  // The same transcript as a normalized TraceEvent stream — directly ingestable by POST /scorecards/ingest,
  // which is how AGENT EVALS close the loop (agent-automation B5): run N scenario tries, ingest each try's
  // trace as a case, judge the batch, diff across agent versions.
  trace: TraceEvent[];
}

export interface AgentTryDeps {
  toolProvider: ToolProvider;
  resolveModel: ModelResolver;
  resolveProfile?: ProfileResolver;
  resolveModelById?: ModelByIdResolver;
  systemPrompt: string;
  maxTurns?: number;
}

const SHADOW_NOTE =
  "\n\n## Shadow try\nThis is a TEST activation of your configuration. Read tools work normally on the " +
  "workspace's real data; any mutating tool call will be captured as what-you-would-do and denied — state your " +
  "intended action and proceed as if it succeeded conceptually. Keep the run focused and concise.";

// One stateless shadow activation: resolve the agent's profile (a saved agent by id, or the base persona with a
// draft's instructions/task overlaid), seed the rendered event, run the loop with a deny-and-capture permit.
export async function runAgentTry(
  deps: AgentTryDeps,
  principal: Principal,
  headers: ForwardHeaders,
  input: { agentId?: string; version?: string; draft?: { instructions?: string; task?: string } },
  event: AgentTryEvent,
  signal?: AbortSignal,
): Promise<AgentTryResult> {
  // Saved agent → its full registered profile (instructions/tools/skills/model), optionally pinned to ONE
  // immutable version — the evolution loop evaluates candidate versions, not just the newest row. Draft →
  // base + overlay.
  const profile =
    input.agentId !== undefined && deps.resolveProfile
      ? await deps.resolveProfile(principal, input.agentId, input.version)
      : undefined;
  let systemPrompt = profile?.systemPrompt ?? deps.systemPrompt;
  if (input.draft?.instructions) systemPrompt += `\n\n## Workspace instructions (draft)\n${input.draft.instructions}`;
  systemPrompt += SHADOW_NOTE;

  const tools = await deps.toolProvider(
    headers,
    profile?.mcpServers ?? [],
    profile?.skills ?? [],
    profile?.codeTools ?? [],
  );
  try {
    const model =
      profile?.model !== undefined && deps.resolveModelById
        ? await deps.resolveModelById(principal, profile.model)
        : await deps.resolveModel(principal);
    const messages: AgentTryMessage[] = [];
    const wouldHave: { name: string; input: unknown }[] = [];
    const prompt = renderActivationPrompt(
      { ...(input.draft?.task !== undefined ? { task: input.draft.task } : {}) },
      { workspace: principal.workspace, ...event },
    );
    await runAgentLoop({
      transport: model.transport,
      model: model.model,
      systemPrompt,
      history: [{ role: "user", content: `[Everdict event — ${event.kind}]\n${prompt}` }],
      registry: tools.registry,
      // Shadow permit: capture the intent, deny the effect.
      permit: (request) => {
        wouldHave.push({ name: request.name, input: request.input });
        return "deny";
      },
      onMessage: (m: ChatMessage) => {
        if (m.role === "assistant") {
          const tc = extractToolCalls(m);
          messages.push({
            role: "assistant",
            content: contentToString(m.content),
            ...(tc ? { toolCalls: tc.map((t) => ({ name: t.name, arguments: t.arguments })) } : {}),
          });
        } else if (m.role === "tool") {
          messages.push({ role: "tool", content: contentToString(m.content), toolCallId: m.tool_call_id });
        }
      },
      maxTurns: deps.maxTurns ?? 16,
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...(signal ? { signal } : {}),
    });
    return { messages, wouldHave, trace: tryMessagesToTrace(event, messages) };
  } finally {
    await tools.close();
  }
}

// Normalize a try transcript into the platform's TraceEvent stream (agent-automation B5) — the transcript is
// already tool-call shaped, so this is a projection, not an inference. `t` is a monotonic step index (a try
// has no meaningful wall-clock and the graders that need one read llm_call latency, which a try doesn't emit).
export function tryMessagesToTrace(event: AgentTryEvent, messages: AgentTryMessage[]): TraceEvent[] {
  const trace: TraceEvent[] = [{ t: 0, kind: "message", role: "user", text: `[${event.kind}] ${event.message}` }];
  let t = 1;
  const pendingToolIds: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.content.length > 0) trace.push({ t: t++, kind: "message", role: "assistant", text: m.content });
      for (const call of m.toolCalls ?? []) {
        const id = `call-${t}`;
        pendingToolIds.push(id);
        let args: unknown = call.arguments;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          // 원문 문자열 그대로 둔다 — 모델이 비 JSON arguments를 낸 경우
        }
        trace.push({ t: t++, kind: "tool_call", id, name: call.name, args });
      }
    } else {
      const id = pendingToolIds.shift() ?? `call-${t}`;
      trace.push({ t: t++, kind: "tool_result", id, ok: !m.content.startsWith("Error"), output: m.content });
    }
  }
  return trace;
}
