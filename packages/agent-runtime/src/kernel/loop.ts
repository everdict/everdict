import { createHash } from "node:crypto";
import { UpstreamError } from "@everdict/contracts";
import { type TaskEnvelope, budgetExhausted, envelopeAllows } from "@everdict/contracts";
import type {
  LlmTransport,
  LlmUsage,
  ReasoningCarrier,
  ReasoningRequest,
  StreamResult,
  TransientCarrier,
} from "@everdict/llm";
import { capMedia, compactStep } from "../context/compaction.js";
import { type TokenBudget, effectiveBudget, estimateTokens, thresholdReached } from "../context/token-budget.js";
import { buildSummarizer } from "../llm/summarize.js";
import type { ChatMessage } from "../messages.js";
import { extractDiscoveredToolNames } from "../tools/deferred.js";
import type {
  PermissionDecision,
  PermissionHook,
  ToolDefinition,
  ToolResult,
  ToolResultImage,
} from "../tools/definition.js";
import { invokeTool } from "../tools/invocation.js";
import { buildListTeammatesTool } from "../tools/list-teammates-tool.js";
import { toLlmTools } from "../tools/openai.js";
import { buildPresentPlanTool } from "../tools/plan-tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { OFFLOAD_THRESHOLD_CHARS, ResultStore, buildReadResultTool, offloadResult } from "../tools/result-store.js";
import { buildSendMessageTool } from "../tools/send-message-tool.js";
import { buildSpawnTeammateTool } from "../tools/spawn-teammate-tool.js";
import { buildSpawnAgentTool } from "../tools/spawn-tool.js";
import { type TodoItem, buildTodoTool, extractTodosFromHistory, renderTodoReminder } from "../tools/todo-tool.js";
import { type WaitRequest, buildWaitForTool } from "../tools/wait-for-tool.js";
import { normalizeHistory, wellFormedArguments } from "./normalize.js";
import { buildSystemPrompt } from "./system-prompt.js";

// The slice of a tool result the `tool_result` EVENT carries — evidence, not the transcript (the model's own
// copy stays full / offload-previewed). Sized so a trace of a hundred tool calls stays a record, not a dump.
const TOOL_RESULT_EVENT_CHARS = 4_000;

// How a run ended. "waiting" is deliberately distinct from "end_turn": end_turn means the agent is DONE and the ball
// is the member's, while waiting means the work continues elsewhere and the agent still owes an answer — the host
// keeps the conversation armed (AgentLoopResult.waitRequest) and resumes it when the world moves.
export type StopReason =
  | "end_turn"
  | "max_turns"
  | "token_budget"
  | "no_progress"
  | "aborted"
  | "interrupted"
  | "waiting"
  // The task envelope's hard budget (tokens/time) is exhausted — the run HALTS so the host can checkpoint
  // (halt_checkpoint is the envelope's only exhaustion vocabulary; dying silently mid-task is the failure
  // the envelope exists to prevent). Distinct from "token_budget" (the context-window budget).
  | "budget_exhausted";

// A specialized sub-agent type the model can select via spawn_agent(subagent_type). A type is a ROLE (an instruction
// appended to the sub-task prompt) plus an optional model tier; its tools stay read-only (the isolation invariant).
export interface SubagentType {
  name: string;
  description: string; // shown to the model so it can pick the right type
  instructions?: string; // appended to the sub-task system prompt (the type's role)
  model?: { transport: LlmTransport; model: string }; // a per-type model tier (else subagentModel / the parent's)
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string } // extended-thinking / reasoning token (streamed before the answer)
  | { type: "assistant_message"; content: string }
  // `id` is the model's own call id — it PAIRS a result with its call. Without it an observer has to guess
  // by name, which mis-pairs the moment two calls to the same tool run in parallel.
  | { type: "tool_call"; name: string; args: string; id?: string }
  // `output` is what the model saw (an offloaded result carries its preview), capped for the evidence stream —
  // without it a recorded tool span can only say a result EXISTED, never what it said.
  | { type: "tool_result"; name: string; isError: boolean; id?: string; output?: string }
  // One model call's own token spend, emitted when the call returns — the per-call fact that `onUsage` (a
  // metering aggregate) reports but the EVENT stream never carried, so a span recorder listening on events
  // could not put tokens on the call it was timing. `model` is the model that actually answered (the fallback
  // may differ from the model the run was configured with).
  | {
      type: "usage";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: "permission"; name: string; decision: PermissionDecision }
  | { type: "plan"; plan: string }
  | { type: "input"; messages: number } // user messages injected mid-run via drainInput (steering)
  | { type: "subagent"; id: string; phase: "launched" | "done"; ok?: boolean } // a background (fire-and-forget) sub-agent
  | { type: "fallback"; from: string; to: string } // switched to the fallback model after sustained upstream failure
  | { type: "compaction"; droppedMessages: number; mode?: "microcompact" | "summarize" | "drop" }
  | { type: "retry"; attempt: number; delayMs: number; persistent?: boolean } // waiting out a transient model-call failure
  | { type: "truncated"; finishReason: string } // the turn hit the output-token cap (max_tokens/length) — output may be cut off
  | { type: "done"; stopReason: StopReason };

export interface AgentLoopOptions {
  // The provider-native transport (Anthropic / OpenAI / OpenAI-compatible). The kernel never constructs it — the host
  // resolves the workspace's model↔provider binding and injects the right one, so the loop stays provider-agnostic in
  // its own code while the wire it speaks is fully native.
  transport: LlmTransport;
  model: string;
  systemPrompt: string;
  // Full conversation so far, including the latest user message. The kernel never appends user turns on its own — the
  // one exception is the drainInput seam (below), through which the host injects mid-run user steering.
  history: ChatMessage[];
  registry: ToolRegistry;
  maxTurns?: number;
  maxTokens?: number;
  // Retries of a single model call on a transient upstream error (429/5xx/network), same model, exponential
  // backoff + jitter capped at 32s; the server's own Retry-After / rate-limit-reset pacing (surfaced by the
  // transport as extra.retryAfterMs) is honored over the computed backoff.
  maxRetries?: number;
  // Unattended-run resilience: when true, CAPACITY errors (429/529/overloaded) never exhaust the retry budget —
  // the loop keeps waiting (backoff capped at 5min, Retry-After honored) until the run signal aborts, emitting a
  // `retry` event per wait so the host can surface/heartbeat it. For headless paths (teammates, activations)
  // where surviving a capacity dip beats failing fast; interactive chat stays fail-fast. Non-capacity transients
  // still follow maxRetries + the fallback ladder.
  persistentRetry?: boolean;
  // Output-token cap per model call (the provider's max_tokens). Absent → the transport's default.
  outputTokens?: number;
  // Soft interrupt (Claude Code's ESC reinterpreted): hands the host a trigger that aborts only the IN-FLIGHT
  // step — the model stream, a retry wait, or the executing tool batch — while the LOOP survives. An interrupted
  // tool batch closes its pairing with synthetic results; then the loop drains queued input: messages queued →
  // the turn continues redirected; nothing queued → the run ends with stopReason "interrupted" (stop and wait
  // for the user — a bare ESC). Distinct from the run signal, which kills the whole turn.
  onInterruptReady?: (interrupt: () => void) => void;
  // Structured output (Claude Code's --json-schema StructuredOutput tool, reinterpreted for programmatic hosts —
  // activations, reactions, evals): when set, the loop registers a `structured_output` tool whose parameters ARE
  // this JSON Schema; the model submits its final result through it and the run ends with the value on
  // AgentLoopResult.structuredOutput. A run that tries to finish without submitting is nudged ONCE, then accepted
  // (the host can treat a missing value as a soft failure).
  outputSchema?: Record<string, unknown>;
  // Waiting (LESSON 051): offer the `wait_for` tool, listing the event kinds this host can resume the conversation
  // on. When the agent calls it the run ends with stopReason "waiting" and the request rides out on the result, for
  // the host to persist as a durable wake intent. Absent → the tool is not registered and an agent that started slow
  // work can only end its turn (handing the job back to the member) or spin.
  waitFor?: { kinds: readonly string[] };
  // Resilience: a cheaper/alternate model to fall back to when the primary keeps failing transiently (sustained
  // 429/overloaded) even after retries. Switched to for the rest of the run; a fallback is both a cost tier and an SLA.
  fallback?: { transport: LlmTransport; model: string };
  temperature?: number;
  signal?: AbortSignal;
  // The task's DECISION BOUNDARY (trust-kernel O5). When set: forbidden capabilities are refused for EVERY
  // tool call and out-of-scope ones for every WRITE call (reads are the agent's senses; effects are what the
  // scope governs) — the refusal instructs the model to replan, never to work around. Hard budgets
  // (tokens/timeSec) halt the run with stopReason "budget_exhausted" so the host can checkpoint. The usd
  // budget is enforced by the host's meter (the loop reports tokens; only the host prices them).
  envelope?: TaskEnvelope;
  // Rung-2 (LLM) compaction: digest the old span into a summary. Defaults to a summariser bound to this loop's own
  // model (buildSummarizer); the host can pass one bound to a cheaper "small/fast" model so a mechanical digest doesn't
  // burn the main model. Return "" to decline (loop falls through to structural).
  summarize?: (oldSpan: ChatMessage[]) => Promise<string>;
  // Permission gate for write (non-read-only) tool calls — the seam a HITL approval plugs into. Read-only tools skip
  // it (auto-allow); absent hook = allow (write tools are already opt-in). A denied call becomes an error result the
  // model sees and can adapt to.
  permit?: PermissionHook;
  // Mid-run user steering: called at each turn boundary (context balanced) to pull any user messages the host has
  // queued since the run started, which are appended to the conversation before the next model call — Claude Code's
  // queued-message model. Absent → strict turn-based (the historical behaviour). The messages must be role:"user".
  drainInput?: () => ChatMessage[] | Promise<ChatMessage[]>;
  // Sub-agent recursion depth (internal). A top-level run is 0; spawn_agent runs a nested loop at depth+1, and the
  // spawn tool is withheld once depth reaches the cap — so delegation is bounded.
  depth?: number;
  // Upper bound on how many spawn_agent sub-agents may run CONCURRENTLY (a turn can request many at once). Excess
  // spawns queue on a semaphore — parallel delegation without an unbounded fan-out that would exhaust rate limits.
  maxConcurrentSubagents?: number;
  // A separate (typically cheaper) model for spawn_agent sub-agents — delegated research/analysis rarely needs the
  // main model. Absent → sub-agents inherit the parent's model. Composes with the read-only tool scoping.
  subagentModel?: { transport: LlmTransport; model: string };
  // Registered specialized sub-agent TYPES the model can pick via spawn_agent(subagent_type) — each bundles a role
  // instruction and an optional model tier (tools stay read-only). Absent/empty → a single generic sub-agent.
  subagentTypes?: SubagentType[];
  // Host routing for send_message to recipients that are NOT this run's own background sub-agents — a teammate or
  // another session, delivered via the host's mailbox/bus (S2 generalization, agent-teams.md). The kernel tries its own
  // background sub-agents first, then falls back to this. Absent → send_message only reaches this run's sub-agents.
  sendMessage?: (
    to: string,
    message: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  // Host callback to spawn a persistent TEAMMATE (S3) — a long-lived autonomous agent the host creates (session +
  // execution token) and returns its id. Present → the agent gets a spawn_teammate tool (autonomous collaboration:
  // agents, not just the web, spawn teammates). Absent → no spawn_teammate tool.
  spawnTeammate?: (name: string, task: string, watch: string[]) => Promise<{ id: string } | { error: string }>;
  // Host callback listing this run's teammates (S3 discovery) — present → the agent gets a list_teammates tool so it
  // can see who is on the team and coordinate them with send_message. Absent → no list_teammates tool.
  listTeammates?: () => Promise<{ id: string; name: string; watch?: string[] }[]>;
  // Per-tool wall-clock deadline (ms). A tool call that outruns it is aborted and returned as an error the model sees,
  // so a hung MCP tool can't pin the turn's Promise.all forever. Absent → no per-tool timeout (the run signal still applies).
  toolTimeoutMs?: number;
  // Plan mode: start read-only-only; the agent must present_plan and get it approved (onPlan) before any write tool
  // runs. onPlan defaults to auto-approve. Off unless the host opts in.
  planMode?: boolean;
  // `expectedTools`: the write tools the plan declared (LESSON 059 P4) — the host may pre-authorize them on approval.
  onPlan?: (plan: string, expectedTools?: string[]) => boolean | Promise<boolean>;
  // Extended thinking: when set, the model is asked to reason before answering (Anthropic `thinking` budget; OpenAI-side
  // reasoning models reason regardless, so this is a no-op there). Reasoning is CAPTURED either way and surfaced via
  // `reasoning_delta` events + the assistant message's reasoning. Absent → thinking off (the historical behaviour).
  thinking?: ReasoningRequest;
  onEvent?: (e: AgentEvent) => void;
  // Fired once per model turn with that turn's token usage (input/output/cache) — the host meters LLM cost from it
  // (the loop reports tokens; the host prices them). Absent → no metering. See docs/architecture/usage-metering.md.
  onUsage?: (usage: LlmUsage) => void;
  // Fired (awaited) as each assistant/tool message is appended, so the host can persist the transcript
  // incrementally — the source of live progress for a polling UI.
  onMessage?: (message: ChatMessage) => void | Promise<void>;
}

export interface AgentLoopResult {
  content: string;
  stopReason: StopReason;
  turns: number;
  tokensConsumed: number;
  // The new messages produced this run (assistant + tool turns) for persistence; excludes the input history.
  produced: ChatMessage[];
  toolCalls: { name: string; ok: boolean }[];
  // The value the model submitted via the structured_output tool (only with opts.outputSchema; absent when the
  // model never submitted — the nudge is best-effort, not a hard guarantee).
  structuredOutput?: unknown;
  // Set together with stopReason "waiting": what the agent parked itself on. The host stamps the deadline and
  // persists it as the conversation's wake intent — the kernel neither reads a clock nor owns durability.
  waitRequest?: WaitRequest;
}

// A high safety cap, not a task budget — the token budget (+ compaction) is the primary limiter for long tasks. 12
// was too low for multi-step goals; compaction keeps the context bounded so more turns don't blow the window.
const DEFAULT_MAX_TURNS = 50;
// 19 retries (20 attempts total) with exponential backoff (500ms base, 32s cap) ≈ 7½ minutes of patience before the
// fallback model / failure — 6 retries (≈ half a minute) still died on sustained provider instability.
const DEFAULT_MAX_RETRIES = 19;
// Circuit breaker: if compaction fires this many times in one run without the context ever fitting, stop instead of
// hammering the summariser forever on an irrecoverably-oversized context. Shared by the proactive + reactive paths.
const MAX_COMPACTIONS = 12;
// Sub-agent delegation depth cap — a top-level agent can spawn one level of sub-agents; those can't spawn further.
const MAX_AGENT_DEPTH = 1;
// Default cap on concurrently-running spawn_agent sub-agents (a turn may request many; excess queue).
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;
// No-progress guard: stop if the model asks for the EXACT same tool-call batch this many turns in a row (it has already
// seen the identical result twice and repeated anyway → it's stuck, not progressing). Prevents silent token burn.
const NO_PROGRESS_LIMIT = 3;
// Completion-forcing nudges (LESSON 059 P3). The verify nudge is appended to the write_todos RESULT at the exact
// moment the last open item closes — the moment completion-skips actually happen; a rule in the system prompt does
// not survive it. "You cannot certify your own work" is the load-bearing sentence: the failure mode is the model
// closing out with a caveated summary instead of an independent check.
const VERIFY_CLOSEOUT_NUDGE =
  'NOTE: You just closed out a list of 3+ items and none of them was a verification step. Before writing your final answer, spawn the verification subagent (spawn_agent with subagent_type "verify") on what you produced and act on its verdict. You cannot certify your own work by adding caveats to a summary — the verdict comes from the verifier.';
// Turns without a write_todos before the per-turn reminder starts asking the model to true up an open checklist.
const STALE_TODO_TURNS = 10;
// Context-anxiety counter: past this fraction of the window, remind the model that compaction (not rushing) owns
// the context problem — models otherwise truncate work "to save context" long before any real pressure exists.
const DONT_RUSH_FRACTION = 0.25;
const DONT_RUSH_REMINDER =
  "<system-reminder>Context length is managed automatically (older tool results are compacted as needed) — do NOT rush, summarize prematurely, or drop remaining work because the conversation is getting long. Finish the task properly.</system-reminder>";
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 32_000;
// Persistent (unattended) capacity waits back off further — up to 5 minutes between attempts.
const PERSISTENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
// A pathological server Retry-After must not park the loop unbounded — cap honoring it at 1 hour.
const RETRY_AFTER_CAP_MS = 60 * 60_000;
// An ATTENDED run has a person watching the panel: honoring a server's pacing is right up to a short wait, but past
// this the waiting IS the failure. A quota that resets in hours (or days — a plan limit) must fail fast and SAY so
// rather than park the chat behind a retry banner nobody can distinguish from a hang. Unattended runs
// (persistentRetry) keep the full patience.
const INTERACTIVE_RETRY_AFTER_MAX_MS = 30_000;

// The retry delay for the attempt: the server's own pacing (Retry-After / rate-limit reset, surfaced by the
// transport) wins when present; else exponential backoff + up-to-25% jitter (herd-splitting), capped. Exported for
// direct unit testing (the loop's sleeps are real timers).
export function retryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, maxDelayMs);
  return base + Math.floor(random() * base * 0.25);
}

// The true UPSTREAM status of a failure. An AppError carries the provider's status in extra.status (the error's own
// .status is OUR HTTP mapping — 502 for every UpstreamError — which made a provider 400 look retryable); a raw
// SDK/network error may carry .status directly.
function upstreamStatusOf(err: unknown): number | undefined {
  const extra = (err as { extra?: { status?: unknown } }).extra;
  if (extra !== null && typeof extra === "object" && typeof extra.status === "number") return extra.status;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

// The server's own retry pacing, when the transport surfaced it (extra.retryAfterMs from Retry-After / reset headers).
function retryAfterMsOf(err: unknown): number | undefined {
  const extra = (err as { extra?: { retryAfterMs?: unknown } }).extra;
  if (extra !== null && typeof extra === "object" && typeof extra.retryAfterMs === "number") return extra.retryAfterMs;
  return undefined;
}

// A transient upstream failure worth a retry on the same model: HTTP 408/429/5xx or a network hiccup. The upstream
// status is authoritative when present (a provider 400 is NOT retryable — before extra.status was consulted, every
// UpstreamError looked like a 502 and got retried); the message regex covers status-less network failures.
function isTransient(err: unknown): boolean {
  const status = upstreamStatusOf(err);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timeout|stream ended prematurely/i.test(
    message,
  );
}

// A capacity error (rate limit / overload) — the class persistentRetry waits out indefinitely.
function isCapacityError(err: unknown): boolean {
  const status = upstreamStatusOf(err);
  if (status === 429 || status === 529) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|529)\b|overloaded/i.test(message);
}

// A context-overflow failure (the prompt itself is too long) — NOT transient: retrying the same request can't help, but
// compacting the context once and retrying CAN. Both providers surface it as a 400/413 with a recognisable message.
function isContextOverflow(err: unknown): boolean {
  if (upstreamStatusOf(err) === 413) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /context.{0,20}(length|window|too long|exceed)|prompt is too long|maximum.{0,12}context|too many tokens|context_length_exceeded|reduce the length|input length/i.test(
    message,
  );
}

// A tiny FIFO semaphore: acquire() resolves with a release fn once a slot is free, bounding concurrency to `max`.
function makeSemaphore(max: number): (fn: () => Promise<string>) => Promise<string> {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
      } else {
        queue.push(() => {
          active += 1;
          resolve();
        });
      }
    });
  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(text);
    return { ok: true, value: v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {} };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// A stable signature of a turn's tool-call batch (name + arguments, order-independent) — the QUESTION half of the
// no-progress guard.
function toolCallSignature(calls: { name: string; arguments: string }[]): string {
  return calls
    .map((c) => `${c.name}(${c.arguments})`)
    .sort()
    .join("|");
}

// The ANSWER half: a digest of what those calls returned. Hashed because a tool result is unbounded (the loop keeps
// only the digest, never the text). Taken from the PRE-offload content — an offload id embeds the turn number, so
// digesting the stored form would make every large result look new and disarm the guard entirely.
function toolResultSignature(outputs: ToolResult[]): string {
  const joined = outputs.map((o) => `${o.isError === true ? "err" : "ok"}:${o.content.length}:${o.content}`).join("|");
  return createHash("sha1").update(joined).digest("hex");
}

// Invoke a tool under a wall-clock deadline: the tool runs with a signal that fires on timeout OR run-abort (so a
// well-behaved tool cancels), and a race guarantees the loop is freed even if the tool ignores the signal. A timeout
// becomes an error result the model sees. `timeoutMs <= 0` (or undefined via the caller) means no deadline.
async function invokeWithTimeout(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  selectedModel: string,
  timeoutMs: number,
  runSignal?: AbortSignal,
): Promise<ToolResult> {
  if (timeoutMs <= 0) {
    return invokeTool(tool, input, { selectedModel, ...(runSignal ? { abortSignal: runSignal } : {}) });
  }
  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  runSignal?.addEventListener("abort", onRunAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ content: `Tool "${tool.name}" exceeded its ${timeoutMs}ms deadline and was aborted.`, isError: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([invokeTool(tool, input, { selectedModel, abortSignal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    runSignal?.removeEventListener("abort", onRunAbort);
  }
}

// One agentic run: LLM call (with progressively-disclosed tools) → dispatch tool calls → feed results back →
// repeat until the model stops asking for tools (end_turn), turns/budget run out, it stalls, or the caller aborts.
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  // Budget = the model's own context window minus output headroom (compact at ~90% of it), not a fixed constant.
  const budget: TokenBudget = { maxTokens: opts.maxTokens ?? effectiveBudget(opts.model), consumed: 0 };
  // Rung-2 compaction summariser — the loop's own model by default (a one-shot digest), overridable for a cheap tier.
  const summarize = opts.summarize ?? buildSummarizer(opts.transport, opts.model);
  const emit = (e: AgentEvent): void => opts.onEvent?.(e);

  // Active model/transport can switch to the fallback mid-run; the primary is the starting point.
  let activeTransport = opts.transport;
  let activeModel = opts.model;
  let usingFallback = false;

  let messages: ChatMessage[] = normalizeHistory(opts.history);
  // Goal persistence: the loop owns a todo list the model manages via write_todos, re-surfaced each turn as a
  // transient system-reminder so a long task stays on-goal. Seeded from a prior run in the same conversation.
  let todos: TodoItem[] = extractTodosFromHistory(messages);
  // Staleness clock (LESSON 059 P3): turns since the model last touched the checklist — past the threshold with
  // items still open, the per-turn reminder asks it to bring the list back in line with reality.
  let turnsSinceTodoWrite = 0;
  // Large tool results are offloaded here (stored full) and previewed to the model, which pages the rest via read_tool_result.
  const resultStore = new ResultStore();
  // Sub-agent delegation: below the depth cap, add spawn_agent — it runs a nested loop (fresh context, read-only tools)
  // at depth+1 and returns only its summary, protecting this agent's context from the sub-task's intermediate output.
  const depth = opts.depth ?? 0;
  // Sub-agents get a READ-ONLY view of the base tools (isolation of capability, not just context): a delegated
  // research/analysis task shouldn't be able to mutate, and N concurrent sub-agents can't race on writes.
  const subagentRegistry = new ToolRegistry(opts.registry.list().filter((t) => t.isReadOnly === true));
  // Bound concurrent sub-agents so a single turn requesting many spawns can't fan out without limit.
  const runSubagent = makeSemaphore(opts.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  // Background (fire-and-forget) sub-agents: launched detached so the parent keeps working (overlap); each pushes its
  // result here on completion, and the loop folds pending results into a later turn (at a turn boundary / before it
  // finishes). Bounded by the same concurrency semaphore + depth cap.
  const backgroundTasks: Promise<void>[] = [];
  const backgroundResults: { id: string; summary: string; ok: boolean }[] = [];
  let bgCounter = 0;
  // Inbound mailbox per RUNNING background sub-agent (S2 agent-teams.md): the parent can send_message to a sub-agent,
  // which drains it at its next step — a fire-and-forget delegate becomes a two-way collaborator. Deleted on completion.
  const bgMailboxes = new Map<string, ChatMessage[]>();
  const subagentTypeByName = new Map((opts.subagentTypes ?? []).map((t) => [t.name, t]));
  const runNestedSubagent = (
    task: string,
    typeName?: string,
    drainSub?: () => ChatMessage[], // background sub-agents get a drainInput over their mailbox; foreground: none
  ): Promise<string> => {
    // A selected type overrides the role instruction + model tier; unknown/absent → the generic researcher.
    const type = typeName !== undefined ? subagentTypeByName.get(typeName) : undefined;
    const role = type?.instructions ?? "Do the work with your (read-only) tools";
    const tier = type?.model ?? opts.subagentModel;
    return runSubagent(() =>
      runAgentLoop({
        // Sub-agents can run on a cheaper model (per-type tier / subagentModel) — delegated work rarely needs the main model.
        transport: tier?.transport ?? opts.transport,
        model: tier?.model ?? opts.model,
        systemPrompt: `${opts.systemPrompt}\n\n## Sub-task\nYou are handling a scoped sub-task delegated by another agent, with your own fresh context. ${role}, then give a clear, self-contained summary of your findings as your FINAL message — that summary is your only output back to the caller.`,
        history: [{ role: "user", content: task }],
        registry: subagentRegistry,
        depth: depth + 1,
        ...(drainSub ? { drainInput: drainSub } : {}),
        ...(opts.fallback ? { fallback: opts.fallback } : {}),
        ...(opts.persistentRetry !== undefined ? { persistentRetry: opts.persistentRetry } : {}),
        ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
        ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.summarize ? { summarize: opts.summarize } : {}),
        // The envelope binds the WHOLE delegated task, sub-agents included (LESSON 059 P5): without this line a
        // scoped parent could spawn an unscoped child — the delegation escape the envelope exists to close.
        // The child re-counts spend from zero (a per-run bound, not a shared pool with the parent).
        ...(opts.envelope ? { envelope: opts.envelope } : {}),
      }).then((r) => r.content),
    );
  };
  const launchBackground = (task: string, typeName?: string): string => {
    bgCounter += 1;
    const id = `bg-${bgCounter}`;
    bgMailboxes.set(id, []);
    emit({ type: "subagent", id, phase: "launched" });
    // The sub-agent drains its inbox each turn (attributed as a message from the delegating agent).
    const drainSub = (): ChatMessage[] => {
      const pending = bgMailboxes.get(id);
      if (!pending || pending.length === 0) return [];
      bgMailboxes.set(id, []);
      return pending;
    };
    const settle = (): void => {
      bgMailboxes.delete(id); // no more deliveries once it's done
    };
    backgroundTasks.push(
      runNestedSubagent(task, typeName, drainSub)
        .then((summary) => {
          settle();
          backgroundResults.push({ id, summary, ok: true });
          emit({ type: "subagent", id, phase: "done", ok: true });
        })
        .catch((err) => {
          settle();
          backgroundResults.push({
            id,
            summary: `(the sub-agent failed: ${err instanceof Error ? err.message : String(err)})`,
            ok: false,
          });
          emit({ type: "subagent", id, phase: "done", ok: false });
        }),
    );
    return id;
  };
  // Route a send_message: this run's own background sub-agents first (in-kernel), else the host seam (a teammate /
  // another session, via the host mailbox — S2 generalization). Unknown everywhere → soft error the model sees.
  const deliverMessage = async (to: string, message: string): Promise<{ ok: boolean; error?: string }> => {
    const box = bgMailboxes.get(to);
    if (box) {
      box.push({ role: "user", content: `[Message from the delegating agent]\n${message}` });
      return { ok: true };
    }
    if (opts.sendMessage) return await opts.sendMessage(to, message);
    return { ok: false, error: `No running background sub-agent "${to}" to message.` };
  };
  const spawnTools: ToolDefinition[] =
    depth < MAX_AGENT_DEPTH
      ? [
          buildSpawnAgentTool(
            runNestedSubagent,
            launchBackground,
            opts.subagentTypes?.map((t) => ({ name: t.name, description: t.description })),
          ),
          buildSendMessageTool(deliverMessage),
          ...(opts.spawnTeammate ? [buildSpawnTeammateTool(opts.spawnTeammate)] : []),
          ...(opts.listTeammates ? [buildListTeammatesTool(opts.listTeammates)] : []),
        ]
      : [];
  // Plan mode: while on, write tools are blocked; present_plan asks the host to approve, then turns it off.
  let inPlanMode = opts.planMode === true;
  const planTools: ToolDefinition[] = opts.planMode
    ? [
        buildPresentPlanTool(async (plan, expectedTools) => {
          emit({ type: "plan", plan });
          const approved = opts.onPlan ? await opts.onPlan(plan, expectedTools) : true;
          if (approved) inPlanMode = false;
          return approved;
        }),
      ]
    : [];
  // Structured output: the submission tool + its state. isReadOnly — it mutates nothing and must not be parked
  // behind the permission gate or plan mode. TURN registry only: sub-agents (built from opts.registry) never see it.
  let structuredOutput: unknown;
  let hasStructuredOutput = false;
  let structuredNudged = false;
  const structuredTools: ToolDefinition[] = opts.outputSchema
    ? [
        {
          name: "structured_output",
          description:
            "Submit your FINAL result as a structured object matching the required schema. Call this exactly once, when the task is complete — it ends the run.",
          parametersJsonSchema: opts.outputSchema,
          isReadOnly: true,
          call: async (input) => {
            structuredOutput = input;
            hasStructuredOutput = true;
            return { content: "Structured output recorded.", isError: false };
          },
        },
      ]
    : [];
  // Waiting: the agent parks the conversation on an event instead of ending the turn. TURN registry only, like the
  // tools above — a sub-agent has no conversation to be resumed into, so it must not be offered the move.
  let waitRequest: WaitRequest | undefined;
  const waitTools: ToolDefinition[] =
    opts.waitFor && opts.waitFor.kinds.length > 0
      ? [
          buildWaitForTool(opts.waitFor.kinds, (request) => {
            waitRequest = request;
          }),
        ]
      : [];
  const registry = new ToolRegistry([
    ...opts.registry.list(),
    buildTodoTool(
      (t) => {
        todos = t;
        turnsSinceTodoWrite = 0;
      },
      {
        // Completion-forcing nudge (LESSON 059 P3): fires at the exact loop-exit moment where verification
        // skips happen — the write that closes the LAST open item. Only where a verifier exists to spawn
        // (main loop with a registered "verify" subagent type), only on the transition into all-done, and only
        // when no item was itself a verification step. Prompt-level discipline alone does not survive this
        // moment; the tool result is the one channel the model reads right then.
        closeOutNudge: (next) => {
          if (spawnTools.length === 0 || !subagentTypeByName.has("verify")) return undefined;
          if (next.length < 3 || !next.every((t) => t.status === "completed")) return undefined;
          if (todos.length > 0 && todos.every((t) => t.status === "completed")) return undefined; // already closed
          if (next.some((t) => /verif/i.test(t.content))) return undefined;
          return VERIFY_CLOSEOUT_NUDGE;
        },
      },
    ),
    buildReadResultTool(resultStore),
    ...spawnTools,
    ...planTools,
    ...structuredTools,
    ...waitTools,
  ]);
  // Soft-interrupt state: the CURRENT step's controller (the model stream or the tool batch in flight) and the
  // sticky flag the boundaries consume. The trigger is handed to the host once, up front.
  let stepController: AbortController | null = null;
  let stepInterrupted = false;
  const interruptStep = (): void => {
    stepInterrupted = true;
    stepController?.abort();
  };
  opts.onInterruptReady?.(interruptStep);
  // Run a step under its own controller, linked to the run signal (a run abort still cancels the step). The
  // listener is removed when the step settles so long runs don't accumulate them on the run signal.
  const withStep = async <T>(fn: (stepSignal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    if (opts.signal?.aborted || stepInterrupted) controller.abort();
    const onRunAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onRunAbort, { once: true });
    stepController = controller;
    try {
      return await fn(controller.signal);
    } finally {
      stepController = null;
      opts.signal?.removeEventListener("abort", onRunAbort);
    }
  };

  let finalText = "";
  let compactionCount = 0;
  // No-progress guard state: the previous turn's question (tool-call signature) AND answer (result digest), plus how
  // many turns in a row BOTH have repeated. Both halves are needed — see the verdict site below.
  let lastSignature = "";
  let lastResultSignature = "";
  let repeatRun = 0;
  const toolCalls: { name: string; ok: boolean }[] = [];
  // The messages produced this run, accumulated as they are appended — NOT a tail slice of `messages`, which
  // mid-loop compaction can shrink below the input length (that would drop or misattribute produced turns).
  const produced: ChatMessage[] = [];

  // Envelope spend tracking (O5): tokens summed from each model turn's usage; wall-clock from loop start.
  const loopStartedMs = Date.now();
  let envelopeSpentTokens = 0;

  const finish = (stopReason: StopReason, turns: number): AgentLoopResult => {
    emit({ type: "done", stopReason });
    return {
      content: finalText,
      stopReason,
      turns,
      tokensConsumed: budget.consumed,
      produced,
      toolCalls,
      ...(hasStructuredOutput ? { structuredOutput } : {}),
      ...(waitRequest ? { waitRequest } : {}),
    };
  };

  // Commit text the model had already streamed when its step was cut short (a stop, a soft interrupt) as a real
  // assistant turn — the member read it, so it is part of the conversation whether or not the turn finished.
  // A text-only assistant message needs no tool result, so the transcript stays balanced for the next call.
  const commitStreamedText = async (text: string): Promise<void> => {
    if (text.trim().length === 0) return;
    const partial: ChatMessage = { role: "assistant", content: text };
    messages = [...messages, partial];
    produced.push(partial);
    finalText = text;
    await opts.onMessage?.(partial);
  };

  // Fold any completed background sub-agent results into the conversation as a follow-up user turn (labelled). Same
  // seam discipline as drainInput: only called at a balanced turn boundary. Returns whether anything was injected.
  const injectBackgroundResults = async (): Promise<boolean> => {
    if (backgroundResults.length === 0) return false;
    const done = backgroundResults.splice(0);
    const text = done
      .map((r) => `[Background sub-agent ${r.id} ${r.ok ? "finished" : "failed"}]\n${r.summary}`)
      .join("\n\n");
    const message: ChatMessage = { role: "user", content: text };
    messages = [...messages, message];
    produced.push(message);
    await opts.onMessage?.(message);
    emit({ type: "input", messages: done.length });
    return true;
  };

  // Absorb queued input at a balanced boundary. Returns how many messages were injected — the soft-interrupt
  // resolution keys on it (queued → the turn continues redirected; nothing queued → "interrupted").
  const drainQueuedInput = async (): Promise<number> => {
    if (!opts.drainInput) return 0;
    const injected = await opts.drainInput();
    for (const m of injected) {
      messages = [...messages, m];
      produced.push(m);
      await opts.onMessage?.(m);
    }
    if (injected.length > 0) emit({ type: "input", messages: injected.length });
    return injected.length;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) return finish("aborted", turn - 1);

    // The envelope's hard budgets — checked at every turn boundary. Exhaustion HALTS (the host checkpoints);
    // the envelope's only exhaustion vocabulary is halt_checkpoint, so continuing is not an option here.
    if (opts.envelope) {
      const decision = budgetExhausted(opts.envelope, {
        tokens: envelopeSpentTokens,
        timeSec: (Date.now() - loopStartedMs) / 1000,
      });
      if (decision.exhausted) return finish("budget_exhausted", turn - 1);
    }

    // Fold in any background sub-agent results that have completed since the last turn (overlap delivery).
    await injectBackgroundResults();

    // Mid-run steering: pull any user messages the host queued since the run started. Safe here — the context is
    // balanced at a turn boundary (never mid tool_call/result), so appending a user turn keeps the transcript valid.
    const injectedAtBoundary = await drainQueuedInput();

    // A soft interrupt that fired between steps (during compaction/summarize, or racing a boundary) resolves
    // here: queued input means it was a REDIRECT (already absorbed above — continue); a bare interrupt means
    // "stop and wait for the user" (Claude Code's ESC).
    if (stepInterrupted) {
      stepInterrupted = false;
      if (injectedAtBoundary === 0) return finish("interrupted", turn - 1);
    }

    emit({ type: "turn_start", turn });

    const discovered = extractDiscoveredToolNames(messages);
    const tools = toLlmTools(registry, discovered);
    const system = buildSystemPrompt(opts.systemPrompt, registry, discovered);
    // Inject the current todos as a transient reminder (this turn only — never persisted, no history bloat).
    // Marked transient so the transport's rolling prompt-cache breakpoint stays on durable history: this message
    // is re-rendered per call and won't exist at this position next request, so a breakpoint on it is never read.
    turnsSinceTodoWrite += 1;
    const reminderParts: string[] = [];
    const todoReminder = renderTodoReminder(todos, {
      stale: turnsSinceTodoWrite > STALE_TODO_TURNS && todos.some((t) => t.status !== "completed"),
    });
    if (todoReminder.length > 0) reminderParts.push(todoReminder);
    // Context-anxiety counter (LESSON 059 P3): past a quarter of the window, models start rushing, summarizing
    // prematurely, or dropping remaining work "to save context" — say out loud that compaction owns that
    // problem, not the model. One line, transient, same cache discipline as the todo reminder.
    if (budget.maxTokens > 0 && budget.consumed > budget.maxTokens * DONT_RUSH_FRACTION)
      reminderParts.push(DONT_RUSH_REMINDER);
    const reminderMessage: ChatMessage | undefined =
      reminderParts.length > 0 ? { role: "user", content: reminderParts.join("\n") } : undefined;
    if (reminderMessage) (reminderMessage as TransientCarrier).transient = true;

    // `messages` is always balanced at the top of a turn (never a dangling assistant tool_call), so a retry re-sends a
    // valid transcript. On a context-overflow (413), callModel compacts `messages` in place and retries — recovery,
    // not a crash. Returns undefined when the caller aborts.
    // What the CURRENT attempt has streamed so far. An interrupted step returns no result, but the member has
    // already READ this text — commitStreamedText below turns it into a real turn instead of a hole.
    let streamedText = "";
    const callModel = async (): Promise<StreamResult | undefined> => {
      // Persistent capacity waits count separately: the backoff keeps growing to its 5-min cap while the regular
      // transient budget (attempt) is never consumed by them.
      let persistentAttempt = 0;
      for (let attempt = 0; ; attempt++) {
        // Media cap at the REQUEST-BUILD boundary (never on the stored history): a screenshot-driven run crosses
        // the provider's per-request media limit and every retry then fails identically. Ephemeral + recomputed
        // per attempt, so the trace keeps every image and a later compaction frees the budget on its own.
        const withReminder: ChatMessage[] = reminderMessage ? [...messages, reminderMessage] : messages;
        const turnMessages = capMedia(withReminder);
        // A retry re-streams from scratch — only the LAST attempt's text is the one the member is looking at.
        streamedText = "";
        try {
          // Each attempt is its own STEP: a soft interrupt cancels the in-flight stream (the run signal still
          // cancels it too, via the step link) and surfaces below as a non-error exit.
          return await withStep((stepSignal) =>
            activeTransport.stream({
              model: activeModel,
              system,
              messages: turnMessages,
              tools,
              // Cache the stable prefix (system + tools) so long multi-turn runs re-read a cached prefix each turn —
              // the provider's own prompt/KV caching (Anthropic cache_control; OpenAI caches automatically).
              cache: { system: true, tools: true },
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
              ...(opts.outputTokens !== undefined ? { maxTokens: opts.outputTokens } : {}),
              ...(opts.thinking ? { thinking: opts.thinking } : {}),
              signal: stepSignal,
              onContentDelta: (delta) => {
                streamedText += delta;
                emit({ type: "text_delta", delta });
              },
              onReasoningDelta: (delta) => emit({ type: "reasoning_delta", delta }),
            }),
          );
        } catch (err) {
          if (opts.signal?.aborted) return undefined;
          // Soft interrupt mid-stream: not an error — the caller resolves it (redirect or finish "interrupted").
          if (stepInterrupted) return undefined;
          // Reactive recovery: the prompt is too long → compact once and retry the SAME turn (bounded by the shared
          // circuit breaker) instead of failing the run on a single budget-estimate miss.
          if (isContextOverflow(err) && compactionCount < MAX_COMPACTIONS) {
            const step = await compactStep(messages, summarize);
            if (step.mode) {
              compactionCount += 1;
              messages = step.messages;
              emit({ type: "compaction", mode: step.mode, droppedMessages: step.dropped });
              attempt -= 1; // this recovery doesn't consume a transient-retry attempt
              continue;
            }
            // Nothing left to reclaim — fall through to the error.
          }
          const retryAfter = retryAfterMsOf(err);
          // Unattended resilience: capacity errors never exhaust the budget — wait (Retry-After honored, backoff
          // capped at 5min) and try again until the run signal aborts. The fallback ladder is deliberately NOT
          // taken for these: an unattended run prefers waiting out the dip on its own model.
          if (opts.persistentRetry && isCapacityError(err)) {
            persistentAttempt += 1;
            const delayMs = retryDelayMs(persistentAttempt, retryAfter, PERSISTENT_RETRY_MAX_DELAY_MS);
            emit({ type: "retry", attempt: persistentAttempt, delayMs, persistent: true });
            await sleep(delayMs, opts.signal);
            if (opts.signal?.aborted || stepInterrupted) return undefined;
            attempt -= 1; // a capacity wait doesn't consume the transient budget
            continue;
          }
          // The server named a comeback time an attended turn cannot wait out (a plan quota resetting in hours/days
          // arrives as exactly this) — retrying is not recovery, so skip straight to the fallback ladder / the
          // failure, which carries the provider's own reason.
          const waitsTooLong =
            opts.persistentRetry !== true && retryAfter !== undefined && retryAfter > INTERACTIVE_RETRY_AFTER_MAX_MS;
          if (isTransient(err) && attempt < maxRetries && !waitsTooLong) {
            const delayMs = retryDelayMs(attempt, retryAfter);
            emit({ type: "retry", attempt: attempt + 1, delayMs });
            await sleep(delayMs, opts.signal);
            if (opts.signal?.aborted || stepInterrupted) return undefined;
            continue;
          }
          // Retries exhausted on a transient error → switch to the fallback model (once) and keep going.
          if (isTransient(err) && opts.fallback && !usingFallback) {
            usingFallback = true;
            emit({ type: "fallback", from: activeModel, to: opts.fallback.model });
            activeTransport = opts.fallback.transport;
            activeModel = opts.fallback.model;
            attempt = -1; // reset the retry budget for the fallback model (the ++ makes this attempt 0)
            continue;
          }
          // The cause travels in the MESSAGE, not only in `extra`: this string is what the host persists into the
          // transcript and shows the member, and a bare "the model provider call failed" is indistinguishable
          // between a dead key, an exhausted plan quota and a network blip — none of which the member can act on
          // without being told which one it was.
          const detail = err instanceof Error ? err.message : String(err);
          const status = upstreamStatusOf(err);
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            {
              detail,
              attempts: attempt + 1,
              ...(status !== undefined ? { status } : {}),
              ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
            },
            `The model provider call failed after ${attempt + 1} attempt(s): ${detail}`,
          );
        }
      }
    };
    const result = await callModel();
    if (!result) {
      // An interrupted step still produced text the member READ. Commit it as a real assistant turn before the
      // run ends or redirects: dropping it leaves a hole where the answer was, and the next turn would then
      // append a user message straight after a user message with nothing in between to explain the gap.
      await commitStreamedText(streamedText);
      if (opts.signal?.aborted || !stepInterrupted) return finish("aborted", turn - 1);
      // Soft interrupt mid model call: only that partial text was appended (still balanced — a text-only
      // assistant turn pairs with nothing) — absorb the queued redirect and continue, or end the run waiting
      // for the user (a bare interrupt).
      stepInterrupted = false;
      if ((await drainQueuedInput()) > 0) continue;
      return finish("interrupted", turn - 1);
    }

    // Meter this turn's token usage (the host prices it into USD). Fired before the budget bookkeeping below.
    // The same numbers also go out as an EVENT so an observer can attach them to the model call they belong
    // to — `onUsage` is the meter's aggregate channel, the event is the per-call record.
    if (result.usage) {
      envelopeSpentTokens += result.usage.inputTokens + result.usage.outputTokens;
      opts.onUsage?.(result.usage);
      emit({
        type: "usage",
        model: activeModel,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
        ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
      });
    }

    // The turn hit the output-token cap — the text (or a tool call's JSON args) may be cut off mid-way. Surfaced
    // as an event so the host can show/log it; a truncated tool arg then fails JSON parsing below and comes back
    // to the model as an error result it can react to.
    if (result.finishReason === "max_tokens" || result.finishReason === "length") {
      emit({ type: "truncated", finishReason: result.finishReason });
    }

    // The latest turn's total_tokens is the context footprint the MODEL saw; tool results appended after its turn are
    // added as an estimate (hybrid) before the budget check below.
    const usageTokens = result.usage?.totalTokens ?? budget.consumed;
    budget.consumed = usageTokens;

    // content is null (not "") when the turn is tool-calls-only — an empty string alongside tool_calls is rejected by
    // some providers. Map the transport's neutral tool calls into the canonical (OpenAI-shaped) message for storage +
    // tool pairing; the transport translates them back to its own wire format on the next turn. Arguments are
    // normalized to well-formed JSON HERE, before the message is stored or re-sent: the OpenAI wire replays the raw
    // string verbatim, so persisting a malformed fragment bricks every later call. Tool dispatch below still reads
    // the raw result.toolCalls, so the model keeps getting the "Invalid JSON arguments" error it can react to.
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content && result.content.length > 0 ? result.content : null,
      ...(result.toolCalls.length > 0
        ? {
            tool_calls: result.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: wellFormedArguments(tc.arguments) },
            })),
          }
        : {}),
    };
    // Attach the turn's reasoning as a side-channel on the message object: `text` is persisted + shown; `blocks` are the
    // provider-native thinking blocks re-sent verbatim on the next call so Anthropic's tool-use-after-thinking replay
    // holds within this turn. The OpenAI transport strips this before sending (stateless). Carried, never spread to wire.
    if (result.reasoning || result.reasoningBlocks) {
      (assistant as ReasoningCarrier).reasoning = {
        text: result.reasoning ?? "",
        ...(result.reasoningBlocks ? { blocks: result.reasoningBlocks } : {}),
      };
    }
    messages = [...messages, assistant];
    const afterAssistantLen = messages.length; // tool results appended past here aren't in the model's usage count
    produced.push(assistant);
    if (result.content && result.content.length > 0) {
      finalText = result.content;
      emit({ type: "assistant_message", content: result.content });
    }
    await opts.onMessage?.(assistant);

    if (result.toolCalls.length === 0) {
      // Don't answer while background sub-agents are still running — wait for them, fold their findings in, and give
      // the model one more turn to react. Only then finish (no pending results → done).
      if (backgroundTasks.length > 0) {
        await Promise.all(backgroundTasks);
        if (await injectBackgroundResults()) continue;
      }
      // Structured output was required but never submitted — nudge ONCE, then accept the plain finish (the host
      // treats a missing structuredOutput as its own soft failure).
      if (opts.outputSchema && !hasStructuredOutput && !structuredNudged) {
        structuredNudged = true;
        const nudge: ChatMessage = {
          role: "user",
          content:
            "You have not submitted your final result. Call the structured_output tool now with an object matching the required schema.",
        };
        messages = [...messages, nudge];
        produced.push(nudge);
        await opts.onMessage?.(nudge);
        continue;
      }
      return finish("end_turn", turn);
    }

    // No-progress guard, half 1: this turn's tool-call signature. The repeat count is NOT decided here — an
    // identical REQUEST is not evidence of a stall on its own (watching an async job re-asks the same question
    // by design). The verdict waits for the results below: same question AND same answer.
    const signature = toolCallSignature(result.toolCalls);

    const turnImages: ToolResultImage[] = []; // images returned by this turn's tools → one follow-up multimodal turn
    for (const tc of result.toolCalls) emit({ type: "tool_call", name: tc.name, args: tc.arguments, id: tc.id });

    const dispatchOne = async (
      tc: { name: string; arguments: string },
      stepSignal: AbortSignal,
    ): Promise<ToolResult> => {
      const tool = registry.get(tc.name);
      const parsed = parseArgs(tc.arguments);
      if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
      if (!parsed.ok) return { content: `Invalid JSON arguments: ${parsed.error}`, isError: true };
      // The envelope's scope gate (O5): forbidden refuses EVERY call; out-of-scope refuses WRITE calls
      // (reads are the agent's senses — effects are what the scope governs). The refusal is an instruction
      // to REPLAN, and working around it (another tool, a script) is exactly what the wording forbids.
      if (opts.envelope) {
        const decision = envelopeAllows(opts.envelope, tool.name);
        if (!decision.allowed && (decision.reason === "forbidden" || tool.isReadOnly !== true)) {
          return {
            content: `Envelope refusal (${decision.reason}): the tool "${tool.name}" is ${
              decision.reason === "forbidden"
                ? "explicitly forbidden by this task's envelope."
                : "outside this task's allowed capabilities."
            } Do NOT work around this with another tool or a script. Stop this approach, present a revised plan naming the additional capability you need and its risks, and request approval (refuse_and_replan).`,
            isError: true,
          };
        }
      }
      if (tool.isReadOnly !== true && inPlanMode) {
        return {
          content: `In plan mode — the write tool "${tool.name}" is blocked until your plan is approved. Present a plan with present_plan first.`,
          isError: true,
        };
      }
      if (tool.isReadOnly !== true && opts.permit) {
        // Write tool + a permission hook → gate it (read-only tools + no hook auto-allow).
        const decision = await opts.permit({
          name: tool.name,
          isReadOnly: false,
          input: parsed.value,
          // The capability's own declaration rides along, so the host classifies risk from what the author
          // stated rather than from how the tool happens to be spelled.
          ...(tool.effects ? { effects: tool.effects } : {}),
        });
        emit({ type: "permission", name: tool.name, decision });
        if (decision === "deny")
          return {
            content: `Permission denied: the tool "${tool.name}" was not approved by the user.`,
            isError: true,
          };
      }
      return invokeWithTimeout(tool, parsed.value, activeModel, opts.toolTimeoutMs ?? 0, stepSignal);
    };
    // Dispatch the turn's tool calls with WRITE-SAFETY partitioning (Claude Code's isConcurrencySafe partition,
    // reinterpreted over isReadOnly): consecutive read-only calls run CONCURRENTLY (the model asks for independent
    // reads together), while a non-read-only call runs ALONE, in request order — two writes in one turn (or a write
    // and the reads around it) must never race each other. An unknown tool runs no code, so it groups as read-only.
    // Results are appended in call order either way, so the assistant.tool_calls ↔ tool pairing stays ordered.
    const isReadOnlyCall = (tc: { name: string }): boolean => {
      const tool = registry.get(tc.name);
      return tool === undefined || tool.isReadOnly === true;
    };
    // The whole dispatch runs as ONE step: a soft interrupt (or run abort) stops the WAIT even when a tool
    // ignores its signal, and the pairing is closed with synthetic results so the transcript stays balanced.
    const outputs: ToolResult[] = [];
    let batchInterrupted = false;
    await withStep(async (stepSignal) => {
      const interruption = new Promise<"interrupted">((resolve) => {
        stepSignal.addEventListener("abort", () => resolve("interrupted"), { once: true });
      });
      for (let start = 0; start < result.toolCalls.length; ) {
        const head = result.toolCalls[start];
        if (!head) break;
        let end = start + 1;
        if (isReadOnlyCall(head)) {
          while (end < result.toolCalls.length) {
            const next = result.toolCalls[end];
            if (!next || !isReadOnlyCall(next)) break;
            end += 1;
          }
        }
        const slice = result.toolCalls.slice(start, end);
        const settled: (ToolResult | undefined)[] = [];
        const all = Promise.all(
          slice.map((tc, i) =>
            dispatchOne(tc, stepSignal).then((r) => {
              settled[i] = r;
              return r;
            }),
          ),
        );
        const raced = await Promise.race([all, interruption]);
        if (raced === "interrupted") {
          // Close the pairing: settled tools keep their real result, in-flight ones get an outcome-unknown error,
          // never-started ones are marked not-executed. Abandoned promises keep running detached (results discarded).
          batchInterrupted = true;
          for (let i = 0; i < slice.length; i++) {
            outputs.push(
              settled[i] ?? {
                content:
                  "[Interrupted by the user while this tool call was in flight — its outcome is unknown. Verify with a read tool and re-issue it if still needed.]",
                isError: true,
              },
            );
          }
          for (let j = end; j < result.toolCalls.length; j++) {
            outputs.push({
              content: "[Interrupted by the user before this tool call started — it was NOT executed.]",
              isError: true,
            });
          }
          return;
        }
        outputs.push(...raced);
        start = end;
      }
    });
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i];
      const output = outputs[i];
      if (!tc || !output) continue;
      // Offload a large result (store full + preview + id) rather than truncating away its tail; small ones pass through.
      const content =
        output.content.length > OFFLOAD_THRESHOLD_CHARS
          ? offloadResult(resultStore, `result-${turn}-${i}`, output.content)
          : output.content;
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: tc.id, content };
      messages = [...messages, toolMessage];
      produced.push(toolMessage);
      toolCalls.push({ name: tc.name, ok: !output.isError });
      if (output.images && output.images.length > 0) turnImages.push(...output.images);
      emit({
        type: "tool_result",
        name: tc.name,
        isError: output.isError,
        id: tc.id,
        output: content.slice(0, TOOL_RESULT_EVENT_CHARS),
      });
      await opts.onMessage?.(toolMessage);
    }

    // Soft interrupt mid tool batch: the pairing above is closed (real + synthetic results), so this is a
    // balanced boundary — absorb the queued redirect and continue, or end the run waiting for the user. A run
    // abort takes its own exit. Checked BEFORE structured output: the user's interrupt outranks a submission
    // that happened to land in the same batch.
    if (batchInterrupted) {
      if (opts.signal?.aborted) return finish("aborted", turn);
      stepInterrupted = false;
      if ((await drainQueuedInput()) > 0) continue;
      return finish("interrupted", turn);
    }

    // The model submitted its structured result — the run is complete (every tool_call above is answered, so the
    // transcript ends balanced). Still-running background sub-agents are abandoned: the submission is final.
    if (hasStructuredOutput) return finish("end_turn", turn);

    // The agent parked itself on the world (wait_for). Every tool_call in this batch is answered, so the transcript
    // ends balanced and the conversation can be replayed verbatim on resume. Ranked below an interrupt (the member
    // outranks the wait) and below a final submission, but above everything else: once the agent has decided to
    // wait, spending more turns is exactly the spin it chose to avoid.
    if (waitRequest) return finish("waiting", turn);

    // Multimodal tool results: after ALL tool_calls are answered (pairing intact), surface any images the tools
    // returned in ONE follow-up user turn so the model can actually SEE them (chat.completions image_url content).
    // In-run context only — NOT pushed to `produced`/onMessage (base64 must not bloat the durable transcript).
    if (turnImages.length > 0) {
      const imageMessage: ChatMessage = {
        role: "user",
        content: [
          { type: "text", text: `The tool call(s) above returned ${turnImages.length} image(s):` },
          ...turnImages.map((img) => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ],
      };
      messages = [...messages, imageMessage];
    }

    // No-progress guard, half 2 — the verdict. A turn counts as a repeat only when the identical batch came back with
    // the identical results: the model asked the same question AND the world gave the same answer. Judging on the
    // question alone would convict every WATCHER, since polling an async job re-sends the same arguments by design
    // (a scorecard walking 3/50 → 11/50 → 24/50 is progress the loop must not mistake for a spin). The transcript is
    // balanced here (all results appended), so stopping is safe.
    const resultSignature = toolResultSignature(outputs);
    repeatRun = signature === lastSignature && resultSignature === lastResultSignature ? repeatRun + 1 : 1;
    lastSignature = signature;
    lastResultSignature = resultSignature;
    if (repeatRun >= NO_PROGRESS_LIMIT) return finish("no_progress", turn);

    // Hybrid budget: the model's reported usage + an estimate of everything appended since (tool results, image turn).
    budget.consumed = usageTokens + estimateTokens(messages.slice(afterAssistantLen));
    if (thresholdReached(budget)) {
      // Circuit breaker — don't hammer the summariser forever on an irrecoverably-oversized context.
      if (++compactionCount > MAX_COMPACTIONS) return finish("token_budget", turn);
      // Escalation ladder — cheapest, most information-preserving compaction first; stop only if none fit.
      const step = await compactStep(messages, summarize);
      if (step.mode) {
        messages = step.messages;
        emit({ type: "compaction", mode: step.mode, droppedMessages: step.dropped });
      } else {
        return finish("token_budget", turn);
      }
    }
  }

  return finish("max_turns", maxTurns);
}
