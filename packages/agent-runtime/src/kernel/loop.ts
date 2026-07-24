import { UpstreamError } from "@everdict/contracts";
import type { LlmTransport, ReasoningCarrier, ReasoningRequest, StreamResult } from "@everdict/llm";
import { compactStep } from "../context/compaction.js";
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
import { toLlmTools } from "../tools/openai.js";
import { buildPresentPlanTool } from "../tools/plan-tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { OFFLOAD_THRESHOLD_CHARS, ResultStore, buildReadResultTool, offloadResult } from "../tools/result-store.js";
import { buildSendMessageTool } from "../tools/send-message-tool.js";
import { buildSpawnTeammateTool } from "../tools/spawn-teammate-tool.js";
import { buildSpawnAgentTool } from "../tools/spawn-tool.js";
import { type TodoItem, buildTodoTool, extractTodosFromHistory, renderTodoReminder } from "../tools/todo-tool.js";
import { normalizeHistory } from "./normalize.js";
import { buildSystemPrompt } from "./system-prompt.js";

export type StopReason = "end_turn" | "max_turns" | "token_budget" | "no_progress" | "aborted";

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
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "permission"; name: string; decision: PermissionDecision }
  | { type: "plan"; plan: string }
  | { type: "input"; messages: number } // user messages injected mid-run via drainInput (steering)
  | { type: "subagent"; id: string; phase: "launched" | "done"; ok?: boolean } // a background (fire-and-forget) sub-agent
  | { type: "fallback"; from: string; to: string } // switched to the fallback model after sustained upstream failure
  | { type: "compaction"; droppedMessages: number; mode?: "microcompact" | "summarize" | "drop" }
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
  // Retries of a single model call on a transient upstream error (429/5xx/network), same model, fixed backoff.
  maxRetries?: number;
  // Resilience: a cheaper/alternate model to fall back to when the primary keeps failing transiently (sustained
  // 429/overloaded) even after retries. Switched to for the rest of the run; a fallback is both a cost tier and an SLA.
  fallback?: { transport: LlmTransport; model: string };
  temperature?: number;
  signal?: AbortSignal;
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
  spawnTeammate?: (name: string, task: string) => Promise<{ id: string } | { error: string }>;
  // Per-tool wall-clock deadline (ms). A tool call that outruns it is aborted and returned as an error the model sees,
  // so a hung MCP tool can't pin the turn's Promise.all forever. Absent → no per-tool timeout (the run signal still applies).
  toolTimeoutMs?: number;
  // Plan mode: start read-only-only; the agent must present_plan and get it approved (onPlan) before any write tool
  // runs. onPlan defaults to auto-approve. Off unless the host opts in.
  planMode?: boolean;
  onPlan?: (plan: string) => boolean | Promise<boolean>;
  // Extended thinking: when set, the model is asked to reason before answering (Anthropic `thinking` budget; OpenAI-side
  // reasoning models reason regardless, so this is a no-op there). Reasoning is CAPTURED either way and surfaced via
  // `reasoning_delta` events + the assistant message's reasoning. Absent → thinking off (the historical behaviour).
  thinking?: ReasoningRequest;
  onEvent?: (e: AgentEvent) => void;
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
}

// A high safety cap, not a task budget — the token budget (+ compaction) is the primary limiter for long tasks. 12
// was too low for multi-step goals; compaction keeps the context bounded so more turns don't blow the window.
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_RETRIES = 2;
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
const RETRY_BACKOFF_MS = [500, 1500];

// A transient upstream failure worth a retry on the same model: HTTP 429/5xx or a network hiccup.
function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timeout/i.test(message);
}

// A context-overflow failure (the prompt itself is too long) — NOT transient: retrying the same request can't help, but
// compacting the context once and retrying CAN. Both providers surface it as a 400/413 with a recognisable message.
function isContextOverflow(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  if (status === 413) return true;
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

// A stable signature of a turn's tool-call batch (name + arguments, order-independent) — used by the no-progress guard.
function toolCallSignature(calls: { name: string; arguments: string }[]): string {
  return calls
    .map((c) => `${c.name}(${c.arguments})`)
    .sort()
    .join("|");
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
        ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.summarize ? { summarize: opts.summarize } : {}),
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
        ]
      : [];
  // Plan mode: while on, write tools are blocked; present_plan asks the host to approve, then turns it off.
  let inPlanMode = opts.planMode === true;
  const planTools: ToolDefinition[] = opts.planMode
    ? [
        buildPresentPlanTool(async (plan) => {
          emit({ type: "plan", plan });
          const approved = opts.onPlan ? await opts.onPlan(plan) : true;
          if (approved) inPlanMode = false;
          return approved;
        }),
      ]
    : [];
  const registry = new ToolRegistry([
    ...opts.registry.list(),
    buildTodoTool((t) => {
      todos = t;
    }),
    buildReadResultTool(resultStore),
    ...spawnTools,
    ...planTools,
  ]);
  let finalText = "";
  let compactionCount = 0;
  // No-progress guard state: the previous turn's tool-call signature + how many turns in a row it has repeated.
  let lastSignature = "";
  let repeatRun = 0;
  const toolCalls: { name: string; ok: boolean }[] = [];
  // The messages produced this run, accumulated as they are appended — NOT a tail slice of `messages`, which
  // mid-loop compaction can shrink below the input length (that would drop or misattribute produced turns).
  const produced: ChatMessage[] = [];

  const finish = (stopReason: StopReason, turns: number): AgentLoopResult => {
    emit({ type: "done", stopReason });
    return {
      content: finalText,
      stopReason,
      turns,
      tokensConsumed: budget.consumed,
      produced,
      toolCalls,
    };
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

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) return finish("aborted", turn - 1);

    // Fold in any background sub-agent results that have completed since the last turn (overlap delivery).
    await injectBackgroundResults();

    // Mid-run steering: pull any user messages the host queued since the run started. Safe here — the context is
    // balanced at a turn boundary (never mid tool_call/result), so appending a user turn keeps the transcript valid.
    if (opts.drainInput) {
      const injected = await opts.drainInput();
      if (injected.length > 0) {
        for (const m of injected) {
          messages = [...messages, m];
          produced.push(m);
          await opts.onMessage?.(m);
        }
        emit({ type: "input", messages: injected.length });
      }
    }

    emit({ type: "turn_start", turn });

    const discovered = extractDiscoveredToolNames(messages);
    const tools = toLlmTools(registry, discovered);
    const system = buildSystemPrompt(opts.systemPrompt, registry, discovered);
    // Inject the current todos as a transient reminder (this turn only — never persisted, no history bloat).
    const reminder = renderTodoReminder(todos);

    // `messages` is always balanced at the top of a turn (never a dangling assistant tool_call), so a retry re-sends a
    // valid transcript. On a context-overflow (413), callModel compacts `messages` in place and retries — recovery,
    // not a crash. Returns undefined when the caller aborts.
    const callModel = async (): Promise<StreamResult | undefined> => {
      for (let attempt = 0; ; attempt++) {
        const turnMessages: ChatMessage[] =
          reminder.length > 0 ? [...messages, { role: "user", content: reminder }] : messages;
        try {
          return await activeTransport.stream({
            model: activeModel,
            system,
            messages: turnMessages,
            tools,
            // Cache the stable prefix (system + tools) so long multi-turn runs re-read a cached prefix each turn —
            // the provider's own prompt/KV caching (Anthropic cache_control; OpenAI caches automatically).
            cache: { system: true, tools: true },
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.thinking ? { thinking: opts.thinking } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
            onContentDelta: (delta) => emit({ type: "text_delta", delta }),
            onReasoningDelta: (delta) => emit({ type: "reasoning_delta", delta }),
          });
        } catch (err) {
          if (opts.signal?.aborted) return undefined;
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
          if (isTransient(err) && attempt < maxRetries) {
            await sleep(RETRY_BACKOFF_MS[attempt] ?? 1500, opts.signal);
            if (opts.signal?.aborted) return undefined;
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
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { detail: err instanceof Error ? err.message : String(err), attempts: attempt + 1 },
            "The model provider call failed.",
          );
        }
      }
    };
    const result = await callModel();
    if (!result) return finish("aborted", turn - 1);

    // The latest turn's total_tokens is the context footprint the MODEL saw; tool results appended after its turn are
    // added as an estimate (hybrid) before the budget check below.
    const usageTokens = result.usage?.totalTokens ?? budget.consumed;
    budget.consumed = usageTokens;

    // content is null (not "") when the turn is tool-calls-only — an empty string alongside tool_calls is rejected by
    // some providers. Map the transport's neutral tool calls into the canonical (OpenAI-shaped) message for storage +
    // tool pairing; the transport translates them back to its own wire format on the next turn.
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content && result.content.length > 0 ? result.content : null,
      ...(result.toolCalls.length > 0
        ? {
            tool_calls: result.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
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
      return finish("end_turn", turn);
    }

    // No-progress guard: track whether this turn's tool-call batch is identical to the previous turns'.
    const signature = toolCallSignature(result.toolCalls);
    repeatRun = signature === lastSignature ? repeatRun + 1 : 1;
    lastSignature = signature;

    const turnImages: ToolResultImage[] = []; // images returned by this turn's tools → one follow-up multimodal turn
    for (const tc of result.toolCalls) emit({ type: "tool_call", name: tc.name, args: tc.arguments });

    // Dispatch the turn's tool calls CONCURRENTLY (Claude Code parity — the model asks for independent tools together),
    // then append the results in call order so the assistant.tool_calls ↔ tool pairing stays ordered.
    const outputs: ToolResult[] = await Promise.all(
      result.toolCalls.map(async (tc): Promise<ToolResult> => {
        const tool = registry.get(tc.name);
        const parsed = parseArgs(tc.arguments);
        if (!tool) return { content: `Unknown tool: ${tc.name}`, isError: true };
        if (!parsed.ok) return { content: `Invalid JSON arguments: ${parsed.error}`, isError: true };
        if (tool.isReadOnly !== true && inPlanMode) {
          return {
            content: `In plan mode — the write tool "${tool.name}" is blocked until your plan is approved. Present a plan with present_plan first.`,
            isError: true,
          };
        }
        if (tool.isReadOnly !== true && opts.permit) {
          // Write tool + a permission hook → gate it (read-only tools + no hook auto-allow).
          const decision = await opts.permit({ name: tool.name, isReadOnly: false, input: parsed.value });
          emit({ type: "permission", name: tool.name, decision });
          if (decision === "deny")
            return {
              content: `Permission denied: the tool "${tool.name}" was not approved by the user.`,
              isError: true,
            };
        }
        return invokeWithTimeout(tool, parsed.value, activeModel, opts.toolTimeoutMs ?? 0, opts.signal);
      }),
    );
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
      emit({ type: "tool_result", name: tc.name, isError: output.isError });
      await opts.onMessage?.(toolMessage);
    }

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

    // No-progress stop: the model has now asked for the identical tool batch NO_PROGRESS_LIMIT turns running (it saw
    // the same results and repeated anyway). The transcript is balanced (results appended) — stop the spin.
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
