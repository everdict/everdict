import { type ChatMessage, isKernelRefusal, runAgentLoop } from "@everdict/agent-runtime";
import type { TraceEvent } from "@everdict/contracts";
import { renderActivationPrompt } from "./agent-activation.js";
import { contentToString, extractToolCalls } from "./chat.js";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelByIdResolver, ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";
import type { ProfileResolver } from "./profile.js";

// Agent try-drive (docs/architecture/agent-automation.md B3) — the crafting crux: fire a (replayed or hand-built)
// platform event at an agent BEFORE enabling it, in SHADOW mode, and watch what it would do. The PLATFORM's own read
// tools run for real against the workspace's data (the caller's own bearer bounds them); everything else — every
// workspace-registered server's tool, every code tool, every mutation — is captured as a would-have-done intent and
// never invoked, so a try can never have side effects. Stateless: no session, nothing persisted.
//
// That promise is the kernel's ExecutionMode, not a rule this file applies: a host-side permission hook is asked only
// about calls the kernel classifies as needing consent, and for a third party's tool that classification is the third
// party's own claim. This file's job is the ATTESTATION (which tools it can vouch for as pure reads); enforcement
// happens at the invocation point.

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
  // tool rows: how the call went, as the KERNEL reported it (AgentEvent.tool_result) rather than as the text reads.
  // Absent only for a transcript assembled by someone other than the loop.
  isError?: boolean;
  // …and WHY, when the kernel is the one who decided: this call was captured by a shadow run, never invoked.
  outcome?: "shadow_denied";
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
  "\n\n## Shadow try\nThis is a TEST activation of your configuration. Everdict's own read tools work normally on " +
  "the workspace's real data; every other call — any mutation, and ANY tool from a connected external server, even " +
  "one that only reads — is captured as what-you-would-do and not executed. A captured call says so in its result: " +
  "state your intended action and proceed as if it succeeded conceptually, do not retry it and do not look for " +
  "another route to it. Keep the run focused and concise.";

// One stateless shadow activation: resolve the agent's profile (a saved agent by id, or the base persona with a
// draft's instructions/task overlaid), seed the rendered event, run the loop in shadow mode.
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
    // How each tool call ACTUALLY went, by the call id it answers — the kernel's own account of it, taken from the
    // event stream (emitted just before the matching tool message). Without this the transcript is text and the
    // projector below has to guess, which is how a withheld call came to be scored as a working one.
    const outcomeById = new Map<string, { isError: boolean; outcome?: "shadow_denied" }>();
    await runAgentLoop({
      transport: model.transport,
      model: model.model,
      systemPrompt,
      history: [{ role: "user", content: `[Everdict event — ${event.kind}]\n${prompt}` }],
      registry: tools.registry,
      // "No side effects" is the MODE of this execution, enforced by the kernel at the invocation point — not a
      // permission hook answering deny to the subset of calls the kernel bothers to ask about. Only the tools this
      // process can attest as pure first-party reads run for real (see ToolSession.attestedReads); every external
      // server's tool, every code tool and every mutation is captured as an intent instead, whatever it is declared
      // to be. The captured intents ARE `wouldHave`.
      mode: { kind: "shadow", executableReads: tools.attestedReads },
      onEvent: (e) => {
        if (e.type === "shadow_intent") wouldHave.push({ name: e.name, input: e.input });
        else if (e.type === "tool_result" && e.id !== undefined)
          outcomeById.set(e.id, {
            isError: e.isError,
            ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
          });
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
          const outcome = m.tool_call_id !== undefined ? outcomeById.get(m.tool_call_id) : undefined;
          messages.push({
            role: "tool",
            content: contentToString(m.content),
            toolCallId: m.tool_call_id,
            ...(outcome ? { isError: outcome.isError } : {}),
            ...(outcome?.outcome !== undefined ? { outcome: outcome.outcome } : {}),
          });
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

// DID THIS TOOL CALL WORK — the question every trace grader asks of `tool_result.ok`, and the one a try trace used
// to answer by reading the first five characters of the result text. A shadow run denies every mutation BY
// CONSTRUCTION, so the kernel's refusal ("Permission denied: …", a captured call, an envelope refusal) is not an edge
// case here but the try path's normal traffic — and none of those sentences start with "Error". A shadow eval
// therefore reported a perfect tool-success rate over a run in which nothing was allowed to happen.
//
// So the answer comes from the kernel: it knows the outcome at the moment it produces it and now carries it on the
// message (`isError`, from the tool_result event). The text check survives only for a transcript nobody attributed —
// and even then it recognizes the kernel's OWN refusal constants rather than a prefix somebody guessed, so a reword
// moves both halves at once. A transcript with neither is taken at face value: unknown is not failure.
function toolCallSucceeded(m: AgentTryMessage): boolean {
  if (m.isError !== undefined) return !m.isError;
  return !(m.content.startsWith("Error") || isKernelRefusal(m.content));
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
          // Left as the raw string — the case where the model emitted non-JSON arguments
        }
        trace.push({ t: t++, kind: "tool_call", id, name: call.name, args });
      }
    } else {
      const id = pendingToolIds.shift() ?? `call-${t}`;
      trace.push({ t: t++, kind: "tool_result", id, ok: toolCallSucceeded(m), output: m.content });
    }
  }
  return trace;
}
