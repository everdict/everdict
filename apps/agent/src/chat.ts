import {
  type AgentEvent,
  type ChatMessage,
  type McpInvoke,
  type PermissionHook,
  type SubagentType,
  ToolRegistry,
  buildSummarizer,
  runAgentLoop,
} from "@everdict/agent-runtime";
import type { AgentSessionStore, AnalysisArtifactStore } from "@everdict/application-control";
import {
  type AgentMessageRecord,
  type AgentReference,
  type AgentReferenceType,
  type AgentToolCall,
  type AnalysisArtifactRecord,
  NotFoundError,
} from "@everdict/contracts";
import type { ReasoningCarrier } from "@everdict/llm";
import { type AgentDraft, buildAgentDraftTools } from "./agent-draft-tool.js";
import type { AgentTryEvent, AgentTryResult } from "./agent-try.js";
import { buildRunAnalysisTool } from "./analysis-script-tool.js";
import { buildArtifactTools } from "./artifact-tools.js";
import type { CodeToolRuntime } from "./code-tools.js";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelByIdResolver, ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";
import type { ProfileResolver } from "./profile.js";
import { buildEnvironmentSection } from "./system-prompt.js";
import { buildViewConfigTool } from "./view-config-tool.js";

// An @-reference resolves to the workspace read tool that fetches that entity's full record. `trace` is the exception:
// it is keyed by (source, id=traceId), so it resolves via inspect_trace with those args (see referenceArgs).
const REFERENCE_TOOL: Record<AgentReferenceType, string> = {
  harness: "get_harness_instance",
  runtime: "get_runtime",
  run: "get_run",
  dataset: "get_dataset",
  scorecard: "get_scorecard",
  judge: "get_judge",
  view: "get_view",
  skill: "get_skill",
  knowledge: "get_knowledge_entry", // a reified claim — the record carries its body AND its lineage fields
  environment: "get_capability", // an environment IS a capability of kind `environment` — one store entity, one read
  tool: "get_capability", // ditto for the tool kinds (mcp | code) — Settings › Agent › Tools hands the agent the spec
  trace: "inspect_trace",
};

// The read-tool arguments for a reference. Most entities read by (id, version?); a `trace` reads by (name=source,
// traceId=id) — inspect_trace's own signature — so the context injection hands the model the trace's normalized events.
// A `tool` may live in ANOTHER workspace (a first-party default is `_everdict`-owned, an adopted tool belongs to its
// publisher), so its owner rides along as get_capability's `source`.
function referenceArgs(ref: AgentReference): Record<string, unknown> {
  if (ref.type === "trace") return { name: ref.source ?? "", traceId: ref.id };
  return {
    id: ref.id,
    ...(ref.version ? { version: ref.version } : {}),
    ...(ref.type === "tool" && ref.source ? { source: ref.source } : {}),
  };
}

const MAX_REFERENCE_CHARS = 4_000;

// Auto-recall (Claude Code's relevant_memories reinterpreted): map each @-reference to its knowledge-graph node
// ref and ask get_task_context ONCE for what the workspace already knows about those anchors — claims/decisions/
// conventions + skill candidates, projected onto the reference's own version coordinate (the anchor-relative
// as-of model). Precision-first: no embedding search — the user's references ARE the anchors; a message with no
// references recalls nothing. `trace` has no knowledge node type (external observability id) — skipped.
const KNOWLEDGE_NODE_TYPE: Partial<Record<AgentReferenceType, string>> = {
  harness: "harness",
  runtime: "runtime",
  run: "run",
  dataset: "dataset",
  scorecard: "scorecard",
  judge: "judge",
  view: "view",
  skill: "skill",
  knowledge: "knowledge",
  environment: "capability", // an environment IS a capability of kind `environment` (same node identity)
  tool: "capability",
};
const MAX_KNOWLEDGE_CHARS = 4_000;

// Recall the workspace's knowledge about the referenced anchors into a turn preamble. Best-effort like reference
// resolution: an unreachable knowledge layer (or zero mappable refs) recalls nothing rather than failing the turn.
async function recallKnowledge(call: McpInvoke, references: AgentReference[]): Promise<string | undefined> {
  const refs = references.flatMap((ref) => {
    const type = KNOWLEDGE_NODE_TYPE[ref.type];
    if (!type) return [];
    return [{ type, key: ref.id, ...(ref.version ? { version: ref.version } : {}) }];
  });
  if (refs.length === 0) return undefined;
  try {
    const r = await call("get_task_context", { refs });
    if (r.isError || r.content.trim().length === 0) return undefined;
    const detail =
      r.content.length > MAX_KNOWLEDGE_CHARS ? `${r.content.slice(0, MAX_KNOWLEDGE_CHARS)}\n… [truncated]` : r.content;
    return `The workspace already KNOWS things about the referenced entities (claims/decisions/conventions from the knowledge layer, projected onto each reference's own version). Inherit them — do not re-derive or contradict them without saying so:\n\n${detail}`;
  } catch {
    return undefined;
  }
}

// Resolve each @-reference via its read tool and assemble a context preamble the model reads before the user's
// words. Best-effort: an unresolved reference degrades to a note rather than failing the turn.
async function resolveReferences(call: McpInvoke, references: AgentReference[]): Promise<string> {
  const blocks: string[] = [];
  for (const ref of references) {
    const args = referenceArgs(ref);
    let detail: string;
    try {
      const r = await call(REFERENCE_TOOL[ref.type], args);
      detail = r.isError ? `(could not resolve: ${r.content.slice(0, 200)})` : r.content;
    } catch (err) {
      detail = `(could not resolve: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (detail.length > MAX_REFERENCE_CHARS) detail = `${detail.slice(0, MAX_REFERENCE_CHARS)}\n… [truncated]`;
    const tag = ref.version ? `${ref.id}@${ref.version}` : ref.id;
    blocks.push(`### Referenced ${ref.type}: ${ref.label} (${tag})\n${detail}`);
  }
  return `The user attached the following workspace context via @-references. Use it to answer.\n\n${blocks.join("\n\n")}`;
}

const MAX_ATTACHMENT_CHARS = 8_000;

// A file the user attached — content is the read text (folded into the model context, not persisted).
export interface AgentAttachmentInput {
  name: string;
  mimeType?: string;
  size?: number;
  content?: string;
}

// The analysis canvas the member is looking at RIGHT NOW (docs/architecture/analysis-studio.md C). The web
// captures it per turn (a synchronous same-window round-trip right before send), so multi-turn refinement —
// "make it a bar chart", "regroup by model" — grounds on the live state INCLUDING the member's manual picker
// changes, not on whatever the agent last applied. config is the stored-form vocabulary apply_view_config takes.
export interface CanvasState {
  config: Record<string, string>;
  viewId?: string | undefined;
}

// The agent-crafting canvas the member has open RIGHT NOW (docs/architecture/agent-automation.md B2/B3 — the
// analysis-canvas pattern applied to crafting). The web captures the draft per turn (same-window round-trip
// right before send), so multi-turn refinement grounds on the live draft INCLUDING the member's manual edits.
export interface AgentDraftState {
  draft: AgentDraft;
  agentId?: string | undefined; // editing an existing registered agent (the canvas opened on it)
}

// Fold the open crafting canvas into the turn context: current draft + the patch rule (craft_agent changes
// only what you send), the verify path (try_agent_draft = shadow run) and the save path (create_agent), so
// craft → try → save closes inside one conversation. The crafted agent is DECLARATION over the same agentic
// loop this conversation runs on — never code, never a second runtime.
function buildDraftPreamble(state: AgentDraftState): string {
  const target = state.agentId ? `the registered agent '${state.agentId}'` : "a new, unsaved agent";
  return [
    `The user has the AGENT CRAFTING canvas open (${target}). The draft's CURRENT state — the exact vocabulary craft_agent patches — is:`,
    JSON.stringify(state.draft),
    "Shape it with craft_agent (a PATCH — send only the fields that change; `clear` unsets). Verify behavior with " +
      "try_agent_draft (a shadow activation: reads run live, mutations are captured as would-have-done and denied) — " +
      "prefer replaying a REAL past event's kind/payload found via list_platform_events. When the user wants to save, " +
      "call create_agent with the agent id and the FULL spec assembled from the draft (set enabled:true only when they " +
      "explicitly want it activated). The crafted agent runs on the SAME agentic loop as this conversation — its spec " +
      "is pure declaration (instructions/task/triggers/permission mode), never code.",
  ].join("\n");
}

// Fold the open canvas into the turn context, with the delta-editing rule spelled out (apply_view_config resets
// unset keys, so "change one thing" means re-sending the kept keys too) and the save path (create_view /
// update_view take this exact config), so "save this analysis" closes in the same conversation.
function buildCanvasPreamble(canvas: CanvasState): string {
  const target = canvas.viewId ? `the saved View '${canvas.viewId}'` : "an unsaved analysis on the analyze dashboard";
  const intro = `The user has the analysis canvas open (${target}). Its CURRENT stored-form config — the exact vocabulary apply_view_config takes — is:`;
  const rule =
    "When the user asks to change the visualization or the analysis itself, call apply_view_config with the FULL " +
    "desired config: start from the current one above, change what they asked, and re-send every key you keep " +
    "(unset keys reset to defaults).";
  const save = canvas.viewId
    ? `If the user asks to save these changes, call update_view with id '${canvas.viewId}' and this config.`
    : "If the user asks to save this analysis, call create_view with a name and this config.";
  return `${intro}\n${JSON.stringify(canvas.config)}\n${rule} ${save}`;
}

// Fold attached text files into a context preamble (their content is not persisted, only their metadata).
function buildAttachmentPreamble(attachments: AgentAttachmentInput[]): string | undefined {
  const blocks: string[] = [];
  for (const a of attachments) {
    if (typeof a.content !== "string" || a.content.length === 0) continue;
    const capped =
      a.content.length > MAX_ATTACHMENT_CHARS
        ? `${a.content.slice(0, MAX_ATTACHMENT_CHARS)}\n… [truncated]`
        : a.content;
    blocks.push(`### Attached file: ${a.name}\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (blocks.length === 0) return undefined;
  return `The user attached the following file(s). Use their content to answer.\n\n${blocks.join("\n\n")}`;
}

export interface ChatDeps {
  sessions: AgentSessionStore;
  // Analysis-artifact persistence (docs/architecture/analysis-studio.md V2). Present → the agent gets the
  // render_chart/render_table/write_report emission tools; absent → no artifact tools (dev without a store).
  artifacts?: AnalysisArtifactStore;
  // run_analysis sandbox (analysis-studio V5) — present AND isolated → the agent may run model-authored analysis
  // scripts (HITL-gated). Wired only when the operator opts in (AGENT_ALLOW_RUN_ANALYSIS); absent → no tool.
  analysisScriptRuntime?: CodeToolRuntime;
  resolveModel: ModelResolver;
  toolProvider: ToolProvider;
  systemPrompt: string; // base persona — used as-is when no resolveProfile is wired (dev / no DB)
  now: () => string;
  newId: () => string;
  maxTurns?: number;
  // Per-workspace agent customization (Phase 1): resolve the workspace's AgentSpec → system prompt (base +
  // instructions), MCP tool servers, and an optional model override. Absent → the base agent (no customization).
  resolveProfile?: ProfileResolver;
  // Resolve the AgentSpec.model override → the LLM client. Only consulted when a profile names a model.
  resolveModelById?: ModelByIdResolver;
  // Model tiering (needs resolveModelById). smallModelRef → a cheaper model digests compaction summaries (resolved
  // lazily, only when compaction fires). fallbackModelRef → an alternate model the run switches to on sustained
  // upstream failure. subagentModelRef → a cheaper model for spawn_agent sub-agents. Absent → the single main model
  // does everything (the historical behaviour).
  smallModelRef?: string;
  fallbackModelRef?: string;
  subagentModelRef?: string;
  // Per-tool wall-clock deadline (ms) forwarded to the loop; a hung tool can't pin a turn forever. Absent → no deadline.
  toolTimeoutMs?: number;
  // Unattended-run resilience (forwarded to the loop): capacity errors (429/529) are waited out indefinitely
  // instead of exhausting the retry budget. Set by the headless callers (teammate/discussion/report turns) via a
  // deps spread — interactive chat stays fail-fast. See AgentLoopOptions.persistentRetry.
  persistentRetry?: boolean;
  // The workspace's registered (crafted) agents as spawnable sub-agent types (registrySubagentTypes) — merged
  // after the builtins (a name collision keeps the builtin). Absent → builtins only (dev / no registry).
  listSubagentTypes?: (principal: Principal) => Promise<SubagentType[]>;
  // Session running memory: once the bounded replay span exceeds this many characters, the oldest records are
  // folded into the session's digest at the turn boundary (see maintainSessionMemory). Ops/test tuning knob;
  // absent → MEMORY_TRIGGER_CHARS.
  memoryTriggerChars?: number;
  // Extended-thinking budget (tokens). Set → the loop asks the model to reason before answering (Anthropic `thinking`;
  // reasoning models reason regardless). Reasoning is captured + streamed either way; absent → thinking off.
  thinkingBudgetTokens?: number;
  // The web app's public base URL (WEB_BASE_URL) — lets the agent hand the member REAL links: entity deep links
  // ({web}/{workspace}/scorecards/<id> …) and the desktop-app download page ({web}/{workspace}/download). Absent →
  // the environment block omits the link lines and the agent should not guess URLs.
  webBaseUrl?: string;
  // Direct desktop-app download URL (DESKTOP_DOWNLOAD_URL, e.g. a GitHub Release) — offered alongside the in-app
  // download page when the operator set it.
  desktopDownloadUrl?: string;
  // Report a conversation's metered LLM usage to the control plane (agent cost → the shared meter + enforcement
  // budget, source "agent"). Called best-effort after a turn completes, ONLY when the model was workspace-billed.
  // Absent (no CONTROL_PLANE_INTERNAL_TOKEN) → agent-conversation cost isn't metered. docs/architecture/usage-metering.md
  reportUsage?: (usage: {
    workspace: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<void>;
}

export interface ChatResult {
  messages: AgentMessageRecord[]; // the newly produced tail (user echo + assistant/tool turns), seq-ordered
}

// Streaming hooks (SSE): onEvent forwards the loop's live events (text deltas, tool call/result); onRecord fires
// as each message (user, assistant, tool) is persisted, so the caller can push the structured record to the client.
export interface ChatHooks {
  onEvent?: (event: AgentEvent) => void;
  onRecord?: (record: AgentMessageRecord) => void;
  // Fires as an analysis artifact (chart/table/report) is persisted — the SSE handler pushes it so the web
  // renders the artifact live in the transcript.
  onArtifact?: (record: AnalysisArtifactRecord) => void;
  // The agent drove the analysis canvas (apply_view_config) — the SSE handler streams the stored-form config so
  // the web applies it live. Present → the tool is registered; absent (headless turns) → no canvas tool.
  onViewConfig?: (config: Record<string, string>) => void;
  // The agent shaped the crafting canvas (craft_agent) — the SSE handler streams the patched draft so the web
  // applies it live. Present → the crafting tools are registered; absent (headless turns) → no crafting tools.
  onAgentDraft?: (draft: AgentDraft) => void;
  // Shadow-run the current draft against a simulated event (try_agent_draft) — the SSE handler binds runAgentTry
  // with the caller's own headers. Only meaningful beside onAgentDraft.
  tryAgentDraft?: (draft: AgentDraft, event: AgentTryEvent) => Promise<AgentTryResult>;
  // Human-in-the-loop approval for write (non-read-only) tool calls — the SSE handler supplies one that pauses the
  // loop, asks the web, and resolves allow/deny. Absent (buffered/API callers) → write tools auto-allow as before.
  permit?: PermissionHook;
  // Mid-run steering: pull any user messages the web queued (POST /input) since this turn started, so the running loop
  // absorbs them at the next turn boundary instead of the user having to Stop and resend. Absent → strict turn-based.
  drainInput?: () => ChatMessage[];
  // Plan mode: start read-only; the agent must present_plan and have it approved (onPlan) before any write tool runs.
  // The SSE handler supplies onPlan to park for the human; absent onPlan → auto-approve.
  planMode?: boolean;
  onPlan?: (plan: string) => boolean | Promise<boolean>;
  // Route send_message to a recipient that is not this run's own background sub-agent (another session/teammate), via
  // the host mailbox (S2 generalization). Absent → send_message only reaches this run's background sub-agents.
  sendMessage?: (
    to: string,
    message: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  // Spawn a persistent teammate (S3) — the host creates its session + execution token and returns its id. Present →
  // the agent gets a spawn_teammate tool (an agent, not just the web, spawns teammates). Absent → no spawn_teammate.
  // `watch` = platform event kinds the teammate should react to proactively (S4).
  spawnTeammate?: (name: string, task: string, watch: string[]) => Promise<{ id: string } | { error: string }>;
  // List the caller's teammates (S3 discovery) → the agent gets a list_teammates tool to coordinate them.
  listTeammates?: () => Promise<{ id: string; name: string; watch?: string[] }[]>;
}

export const DEFAULT_SESSION_TITLE = "New conversation";

// Built-in specialized sub-agent types the model can pick via spawn_agent(subagent_type). Instruction-only (their tools
// stay read-only; they inherit the workspace's sub-agent model tier if one is configured). A role prompt is the main
// lever for this control-plane assistant — the tools are the same read surface, but the framing differs.
const BUILTIN_SUBAGENT_TYPES: SubagentType[] = [
  {
    name: "explore",
    description: "a fast, broad read-only survey to locate the relevant runs/scorecards/harnesses across the workspace",
    instructions: "Survey broadly and quickly across the workspace to locate what is relevant to the task",
  },
  {
    name: "analyze",
    description: "a careful, deep analysis of one entity (a scorecard, a judge trace, a harness) and its details",
    instructions:
      "Analyze the specified entity carefully and thoroughly — inspect its details, failures, and edge cases before summarizing",
  },
  // Adversarial verification (Claude Code's built-in verification agent, reinterpreted for the eval domain). The
  // read-only sub-agent toolset is a QUALIFICATION here, not a limitation: a verifier must not mutate what it
  // verifies. Verification avoidance is the documented failure mode the role prompt counters — verdicts must cite
  // actual tool outputs, never narration of what would be checked.
  {
    name: "verify",
    description:
      "an adversarial verification pass over a claim or finished work — it tries to REFUTE, not confirm, and every verdict must cite read-tool evidence",
    instructions:
      "You are a verification specialist: try to BREAK the claim or work you were handed, not to confirm it. " +
      "Your documented failure mode is verification avoidance — narrating what you would check and writing PASS " +
      "without running anything. Actually call the read tools and cite their outputs as evidence for every point. " +
      "The polished first 80% is not the job: hunt the last 20% — edge cases, empty and error states, numbers " +
      "that don't reconcile, claims the underlying records contradict. End with a verdict of CONFIRMED, REFUTED, " +
      "or INSUFFICIENT EVIDENCE, each backed by the specific tool outputs (or naming exactly what evidence is " +
      "missing). Your read-only toolset is a qualification, not a limitation — a verifier must not mutate what " +
      "it verifies. Do the work with your (read-only) tools",
  },
];

export function contentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

// Replay stored records into the OpenAI message shape the loop expects (assistant tool_calls ↔ tool results).
function recordsToHistory(records: AgentMessageRecord[]): ChatMessage[] {
  return records.map((r): ChatMessage => {
    if (r.role === "assistant") {
      if (r.toolCalls && r.toolCalls.length > 0) {
        return {
          role: "assistant",
          // null (not omitted/"") alongside tool_calls — the shape providers accept for a tool-only turn.
          content: r.content.length > 0 ? r.content : null,
          tool_calls: r.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: "assistant", content: r.content };
    }
    if (r.role === "tool") {
      return { role: "tool", tool_call_id: r.toolCallId ?? "", content: r.content };
    }
    return { role: "user", content: r.content };
  });
}

// Session running memory maintenance (Claude Code's session memory reinterpreted): once the bounded replay span
// outgrows the trigger, fold the oldest records — up to a clean USER boundary, keeping the recent tail verbatim —
// into a fresh digest seeded with the PREVIOUS digest (nothing falls off the end; the memory only rolls forward).
// Runs at the turn boundary on the host, decoupled from the loop's own in-run compaction: compaction fits ONE
// run's context, memory bounds what every FUTURE turn replays.
const MEMORY_TRIGGER_CHARS = 100_000; // ~25k tokens of replayed transcript before folding
const MEMORY_KEEP_RECENT = 20; // records kept verbatim after a fold (the conversation's working set)

export async function maintainSessionMemory(opts: {
  sessions: AgentSessionStore;
  workspace: string;
  sessionId: string;
  previousMemory: string | undefined;
  coveredThroughSeq: number | undefined;
  summarize: (span: ChatMessage[]) => Promise<string>;
  now: string;
  triggerChars?: number;
}): Promise<void> {
  const all = await opts.sessions.listMessages(opts.workspace, opts.sessionId);
  const coveredThrough = opts.coveredThroughSeq;
  const tail = coveredThrough === undefined ? all : all.filter((m) => m.seq > coveredThrough);
  const chars = (opts.previousMemory?.length ?? 0) + tail.reduce((n, m) => n + m.content.length, 0);
  if (chars < (opts.triggerChars ?? MEMORY_TRIGGER_CHARS) || tail.length <= MEMORY_KEEP_RECENT) return;
  // Cut at the first USER record at/after the keep boundary so the remaining tail replays balanced (an assistant
  // tool_call and its results never straddle the cut). No safe boundary → skip; next turn tries again.
  let cut = -1;
  for (let i = tail.length - MEMORY_KEEP_RECENT; i < tail.length; i++) {
    if (tail[i]?.role === "user") {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return;
  const oldSpan = tail.slice(0, cut);
  const throughSeq = oldSpan[oldSpan.length - 1]?.seq;
  if (throughSeq === undefined) return;
  const seeded: ChatMessage[] = [
    ...(opts.previousMemory !== undefined && opts.previousMemory.length > 0
      ? [{ role: "user", content: `[Previous conversation memory]\n${opts.previousMemory}` } satisfies ChatMessage]
      : []),
    ...recordsToHistory(oldSpan),
  ];
  const digest = (await opts.summarize(seeded)).trim();
  if (digest.length === 0) return; // the summariser declined — keep replaying in full rather than dropping context
  await opts.sessions.setSessionMemory(opts.workspace, opts.sessionId, digest, throughSeq, opts.now);
}

export function extractToolCalls(message: ChatMessage): AgentToolCall[] | undefined {
  if (message.role !== "assistant") return undefined;
  const tcs = message.tool_calls;
  if (!tcs || tcs.length === 0) return undefined;
  const out: AgentToolCall[] = [];
  for (const tc of tcs) {
    if (tc.type !== "function") continue;
    out.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
  }
  return out.length > 0 ? out : undefined;
}

function deriveTitle(userText: string): string {
  const firstLine = userText.split("\n")[0]?.trim() ?? "";
  const title = firstLine.length > 0 ? firstLine : DEFAULT_SESSION_TITLE;
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

// One chat turn: persist the user message, replay history into the kernel, run the loop with the workspace's
// read-only MCP tools, then persist the produced assistant/tool transcript. Returns the new tail for the caller.
export async function runChat(
  deps: ChatDeps,
  principal: Principal,
  headers: ForwardHeaders,
  sessionId: string,
  userText: string,
  references?: AgentReference[],
  attachments?: AgentAttachmentInput[],
  signal?: AbortSignal,
  hooks?: ChatHooks,
  canvas?: CanvasState,
  agentDraft?: AgentDraftState,
): Promise<ChatResult> {
  const { workspace, subject } = principal;
  // Visibility-aware: the owner's own session OR a workspace-visible one (a comment-thread discussion session any
  // member may continue). Private sessions stay owner-only — the lookup behaves like getSession for them.
  const session = await deps.sessions.getVisibleSession(workspace, subject, sessionId);
  if (!session) throw new NotFoundError("NOT_FOUND", undefined, "Conversation not found.");

  const allMessages = await deps.sessions.listMessages(workspace, sessionId);
  let seq = allMessages.length === 0 ? 0 : Math.max(...allMessages.map((m) => m.seq)) + 1;
  // Bounded replay (session running memory): with a maintained digest, only the records AFTER the covered seq
  // replay verbatim — the digest leads the history as a synthetic user turn (memoryHistory below). Without one,
  // the whole transcript replays (the historical behaviour).
  const covered = session.memoryThroughSeq;
  const existing = covered === undefined ? allMessages : allMessages.filter((m) => m.seq > covered);
  const memoryHistory: ChatMessage[] =
    session.memory !== undefined && session.memory.length > 0
      ? [
          {
            role: "user",
            content: `[Conversation memory — a digest of the earlier part of this conversation. Continue from it; the original messages are not replayed.]\n\n${session.memory}`,
          },
        ]
      : [];

  const userRecord: AgentMessageRecord = {
    id: deps.newId(),
    tenant: workspace,
    sessionId,
    seq: seq++,
    role: "user",
    content: userText,
    ...(references && references.length > 0 ? { references } : {}),
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            name: a.name,
            ...(a.mimeType !== undefined ? { mimeType: a.mimeType } : {}),
            ...(a.size !== undefined ? { size: a.size } : {}),
          })),
        }
      : {}),
    createdAt: deps.now(),
  };
  await deps.sessions.appendMessages([userRecord]);
  hooks?.onRecord?.(userRecord);

  const producedRecords: AgentMessageRecord[] = [];
  const messageToRecord = (message: ChatMessage): AgentMessageRecord | null => {
    if (message.role === "assistant") {
      const toolCalls = extractToolCalls(message);
      // The loop attaches the turn's reasoning as a side-channel (ReasoningCarrier) on the assistant message; persist
      // its display text so the transcript can re-render the thought process (the native thinking blocks aren't stored).
      const reasoning = (message as ReasoningCarrier).reasoning?.text;
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "assistant",
        content: contentToString(message.content),
        ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        createdAt: deps.now(),
      };
    }
    if (message.role === "tool") {
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "tool",
        content: contentToString(message.content),
        toolCallId: message.tool_call_id,
        createdAt: deps.now(),
      };
    }
    // A user turn reaching the persist path is a mid-run steering message the loop injected via drainInput — persist it
    // so the conversation history keeps it (the initial user message is persisted separately, before the loop).
    if (message.role === "user") {
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "user",
        content: contentToString(message.content),
        createdAt: deps.now(),
      };
    }
    return null;
  };
  // Persist each assistant/tool turn the moment the loop produces it, so a polling client sees tool activity as it
  // happens (not only after the whole loop settles).
  const persist = async (message: ChatMessage): Promise<void> => {
    const record = messageToRecord(message);
    if (!record) return;
    await deps.sessions.appendMessages([record]);
    producedRecords.push(record);
    hooks?.onRecord?.(record);
  };

  // Resolve the workspace's agent customization (Phase 1): system prompt (base + instructions), MCP tool servers, and
  // an optional model override. A trigger-activated run resolves the CRAFTED agent's config (origin.agentId) — its
  // instructions/tools/model are its identity; everything else keeps the workspace chat default.
  const profile = deps.resolveProfile ? await deps.resolveProfile(principal, session.origin?.agentId) : undefined;
  const systemPrompt = profile?.systemPrompt ?? deps.systemPrompt;

  // The MCP session carries this conversation's identity, so anything the agent publishes through the control
  // plane (workspace files) is attributed to the agent + conversation rather than looking like the member's edit.
  const tools = await deps.toolProvider(
    {
      ...headers,
      conversationId: sessionId,
      ...(session.origin?.agentId !== undefined ? { agentId: session.origin.agentId } : {}),
      // P3 causedBy: the run behind this turn — the CP stamps agent-submitted scorecards/runs with it.
      ...(session.runId !== undefined ? { runId: session.runId } : {}),
    },
    profile?.mcpServers ?? [],
    profile?.skills ?? [],
    profile?.codeTools ?? [],
  );
  // Artifact emission tools (analysis-studio V2) — native, per-turn (they carry this session's identity). The
  // registry is immutable, so extend it with a wrapper when a store is wired.
  const artifactTools = deps.artifacts
    ? buildArtifactTools({
        artifacts: deps.artifacts,
        tenant: workspace,
        sessionId,
        createdBy: principal.subject,
        now: deps.now,
        newId: deps.newId,
        ...(hooks?.onArtifact ? { onArtifact: hooks.onArtifact } : {}),
      })
    : [];
  // Canvas control (analysis-studio V3) — only a live web chat wires onViewConfig, so headless turns never
  // carry a tool that has no canvas to drive.
  const canvasTools = hooks?.onViewConfig ? [buildViewConfigTool(hooks.onViewConfig)] : [];
  // Crafting control (agent-automation B2/B3) — same rule: only a live crafting chat wires onAgentDraft.
  const draftTools = hooks?.onAgentDraft
    ? buildAgentDraftTools({
        initial: agentDraft?.draft ?? {},
        onDraft: hooks.onAgentDraft,
        ...(hooks.tryAgentDraft ? { tryDraft: hooks.tryAgentDraft } : {}),
      })
    : [];
  const analysisScriptTool = deps.analysisScriptRuntime ? buildRunAnalysisTool(deps.analysisScriptRuntime) : undefined;
  const extraTools = [
    ...artifactTools,
    ...canvasTools,
    ...draftTools,
    ...(analysisScriptTool ? [analysisScriptTool] : []),
  ];
  const registry = extraTools.length > 0 ? new ToolRegistry([...tools.registry.list(), ...extraTools]) : tools.registry;
  try {
    // Fold any @-referenced entity context into the user turn the model sees (the persisted record keeps the
    // clean text + the reference metadata separately).
    const preambles: string[] = [];
    if (canvas) preambles.push(buildCanvasPreamble(canvas));
    if (agentDraft) preambles.push(buildDraftPreamble(agentDraft));
    if (attachments && attachments.length > 0) {
      const attPreamble = buildAttachmentPreamble(attachments);
      if (attPreamble) preambles.push(attPreamble);
    }
    if (references && references.length > 0 && tools.call) {
      preambles.push(await resolveReferences(tools.call, references));
      // Auto-recall: what the workspace already knows about those anchors rides along (best-effort, one call).
      const recalled = await recallKnowledge(tools.call, references);
      if (recalled) preambles.push(recalled);
    }
    const userForModel =
      preambles.length > 0 ? `${preambles.join("\n\n")}\n\n---\n\nUser message:\n${userText}` : userText;
    const history: ChatMessage[] = [
      ...memoryHistory,
      ...recordsToHistory(existing),
      { role: "user", content: userForModel },
    ];
    // Which registered model powers this turn, in priority order: the conversation's own pick (session.model, set in
    // the chat) → the workspace AgentSpec's model (Settings › Agent) → the agent server's default model.
    const modelRef = session.model ?? profile?.model;
    const model =
      modelRef && deps.resolveModelById
        ? await deps.resolveModelById(principal, modelRef)
        : await deps.resolveModel(principal);
    // Append the per-turn environment block (workspace · model · date) now that the model is resolved.
    const systemWithEnv = `${systemPrompt}\n\n${buildEnvironmentSection({
      workspace,
      model: model.model,
      date: deps.now(),
      taskDirectory: `tasks/${sessionId}`, // per-task separation on the workspace filesystem

      ...(deps.webBaseUrl !== undefined ? { webBaseUrl: deps.webBaseUrl } : {}),
      ...(deps.desktopDownloadUrl !== undefined ? { desktopDownloadUrl: deps.desktopDownloadUrl } : {}),
    })}`;

    // Model tiering (both need the by-id resolver). The summariser is LAZY — the cheaper model is only resolved if a
    // compaction actually fires — so a normal turn pays nothing. The fallback is resolved up front (opt-in per
    // workspace) so it's ready the moment the main model starts failing.
    const byId = deps.resolveModelById;
    const smallRef = deps.smallModelRef;
    const summarize =
      smallRef && byId
        ? async (span: ChatMessage[]): Promise<string> => {
            const small = await byId(principal, smallRef);
            return buildSummarizer(small.transport, small.model)(span);
          }
        : undefined;
    const fallback =
      deps.fallbackModelRef && byId
        ? await byId(principal, deps.fallbackModelRef).then((fb) => ({ transport: fb.transport, model: fb.model }))
        : undefined;
    const subagentModel =
      deps.subagentModelRef && byId
        ? await byId(principal, deps.subagentModelRef).then((sm) => ({ transport: sm.transport, model: sm.model }))
        : undefined;

    // Spawnable sub-agent types: the builtins + the workspace's crafted agents (name collisions keep the
    // builtin — explore/analyze/verify are the stable vocabulary the base prompt teaches). Best-effort.
    const crafted = deps.listSubagentTypes ? await deps.listSubagentTypes(principal) : [];
    const builtinNames = new Set(BUILTIN_SUBAGENT_TYPES.map((t) => t.name));
    const subagentTypes = [...BUILTIN_SUBAGENT_TYPES, ...crafted.filter((t) => !builtinNames.has(t.name))];

    // Accumulate this conversation's token usage across turns (the loop reports tokens; the control plane prices them).
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      await runAgentLoop({
        transport: model.transport,
        model: model.model,
        systemPrompt: systemWithEnv,
        history,
        registry,
        onMessage: persist,
        onUsage: (u) => {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
        },
        ...(summarize ? { summarize } : {}),
        ...(fallback ? { fallback } : {}),
        ...(subagentModel ? { subagentModel } : {}),
        subagentTypes,
        ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
        ...(deps.persistentRetry === true ? { persistentRetry: true } : {}),
        ...(deps.thinkingBudgetTokens !== undefined ? { thinking: { budgetTokens: deps.thinkingBudgetTokens } } : {}),
        ...(hooks?.onEvent ? { onEvent: hooks.onEvent } : {}),
        ...(hooks?.permit ? { permit: hooks.permit } : {}),
        ...(hooks?.drainInput ? { drainInput: hooks.drainInput } : {}),
        ...(hooks?.planMode ? { planMode: hooks.planMode } : {}),
        ...(hooks?.onPlan ? { onPlan: hooks.onPlan } : {}),
        ...(hooks?.sendMessage ? { sendMessage: hooks.sendMessage } : {}),
        ...(hooks?.spawnTeammate ? { spawnTeammate: hooks.spawnTeammate } : {}),
        ...(hooks?.listTeammates ? { listTeammates: hooks.listTeammates } : {}),
        ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Failure is a conversation CITIZEN, not just an exception (Claude Code parity): persist why the turn died
      // as an assistant record before rethrowing, so the transcript shows the failure and the conversation stays
      // continuable — the next turn replays a balanced history (normalizeHistory pairs any dangling tool_calls).
      // A user abort is not a failure. Best-effort: a store write must not mask the original error.
      if (signal?.aborted !== true) {
        const detail = err instanceof Error ? err.message : String(err);
        try {
          await persist({
            role: "assistant",
            content: `[The turn failed: ${detail}] The conversation is intact — send a message to continue.`,
          });
        } catch {}
      }
      throw err;
    } finally {
      // Meter the conversation's LLM cost against the workspace when it ran on a workspace-billed model — the same
      // rule as the harness (own-pays/personal-key/dev conversations are not metered). In a finally so a FAILED or
      // aborted turn's consumed tokens are still billed. Best-effort: never fail the chat.
      if (model.billed && deps.reportUsage && inputTokens + outputTokens > 0) {
        try {
          await deps.reportUsage({ workspace, model: model.model, inputTokens, outputTokens });
        } catch {}
      }
    }

    // Maintain the session's running memory at the turn boundary (successful turns only — a failed turn changed
    // little and rethrew above). Best-effort: a summariser/store failure skips maintenance; next turn retries.
    try {
      await maintainSessionMemory({
        sessions: deps.sessions,
        workspace,
        sessionId,
        previousMemory: session.memory,
        coveredThroughSeq: session.memoryThroughSeq,
        // The same tier rule as in-run compaction: the cheap summariser when configured, else the turn's own model.
        summarize: summarize ?? buildSummarizer(model.transport, model.model),
        now: deps.now(),
        ...(deps.memoryTriggerChars !== undefined ? { triggerChars: deps.memoryTriggerChars } : {}),
      });
    } catch {}
  } finally {
    await tools.close();
  }

  const nextTitle = session.title === DEFAULT_SESSION_TITLE ? deriveTitle(userText) : undefined;
  await deps.sessions.touchSession(workspace, sessionId, deps.now(), nextTitle);

  return { messages: [userRecord, ...producedRecords] };
}
