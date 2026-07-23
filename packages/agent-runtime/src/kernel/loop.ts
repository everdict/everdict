import { UpstreamError } from "@everdict/contracts";
import type OpenAI from "openai";
import { compactMessages, microcompact, summarizeAndCompact } from "../context/compaction.js";
import { type TokenBudget, effectiveBudget, estimateTokens, thresholdReached } from "../context/token-budget.js";
import { type StreamChatResult, streamChat } from "../llm/stream-chat.js";
import { buildSummarizer } from "../llm/summarize.js";
import { type ChatMessage, systemMessage } from "../messages.js";
import { extractDiscoveredToolNames } from "../tools/deferred.js";
import type {
  PermissionDecision,
  PermissionHook,
  ToolContext,
  ToolResult,
  ToolResultImage,
} from "../tools/definition.js";
import { invokeTool } from "../tools/invocation.js";
import { toOpenAiTools } from "../tools/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { type TodoItem, buildTodoTool, extractTodosFromHistory, renderTodoReminder } from "../tools/todo-tool.js";
import { normalizeHistory } from "./normalize.js";
import { buildSystemPrompt } from "./system-prompt.js";

export type StopReason = "end_turn" | "max_turns" | "token_budget" | "aborted";

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "permission"; name: string; decision: PermissionDecision }
  | { type: "compaction"; droppedMessages: number; mode?: "microcompact" | "summarize" | "drop" }
  | { type: "done"; stopReason: StopReason };

export interface AgentLoopOptions {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  // Full conversation so far, including the latest user message. The kernel never appends user turns.
  history: ChatMessage[];
  registry: ToolRegistry;
  maxTurns?: number;
  maxTokens?: number;
  // Retries of a single model call on a transient upstream error (429/5xx/network), same model, fixed backoff.
  maxRetries?: number;
  temperature?: number;
  signal?: AbortSignal;
  // Rung-2 (LLM) compaction: digest the old span into a summary. Defaults to a summariser bound to this loop's own
  // model (buildSummarizer); tests inject a deterministic one. Return "" to decline (loop falls through to structural).
  summarize?: (oldSpan: ChatMessage[]) => Promise<string>;
  // Permission gate for write (non-read-only) tool calls — the seam a HITL approval plugs into. Read-only tools skip
  // it (auto-allow); absent hook = allow (write tools are already opt-in). A denied call becomes an error result the
  // model sees and can adapt to.
  permit?: PermissionHook;
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
// hammering the summariser forever on an irrecoverably-oversized context.
const MAX_COMPACTIONS = 12;
const RETRY_BACKOFF_MS = [500, 1500];
// Cap a single tool result before feeding it back to the model — an unbounded MCP payload (a big scorecard JSON)
// would otherwise dominate the context window in one turn. ~48k chars ≈ ~12k tokens.
const MAX_TOOL_OUTPUT_CHARS = 48_000;

function capToolOutput(content: string): string {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated ${content.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

// A transient upstream failure worth a retry on the same model: HTTP 429/5xx or a network hiccup.
function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timeout/i.test(message);
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

// One agentic run: LLM call (with progressively-disclosed tools) → dispatch tool calls → feed results back →
// repeat until the model stops asking for tools (end_turn), turns/budget run out, or the caller aborts.
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  // Budget = the model's own context window minus output headroom (compact at ~90% of it), not a fixed constant.
  const budget: TokenBudget = { maxTokens: opts.maxTokens ?? effectiveBudget(opts.model), consumed: 0 };
  // Rung-2 compaction summariser — the loop's own model by default (a one-shot digest), overridable for tests.
  const summarize = opts.summarize ?? buildSummarizer(opts.client, opts.model);
  const emit = (e: AgentEvent): void => opts.onEvent?.(e);

  let messages: ChatMessage[] = normalizeHistory(opts.history);
  // Goal persistence: the loop owns a todo list the model manages via write_todos, re-surfaced each turn as a
  // transient system-reminder so a long task stays on-goal. Seeded from a prior run in the same conversation.
  let todos: TodoItem[] = extractTodosFromHistory(messages);
  const registry = new ToolRegistry([...opts.registry.list(), buildTodoTool((t) => (todos = t))]);
  let finalText = "";
  let compactionCount = 0;
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

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) return finish("aborted", turn - 1);
    emit({ type: "turn_start", turn });

    const discovered = extractDiscoveredToolNames(messages);
    const tools = toOpenAiTools(registry, discovered);
    const system = buildSystemPrompt(opts.systemPrompt, registry, discovered);
    // Inject the current todos as a transient reminder (this turn only — never persisted, no history bloat).
    const reminder = renderTodoReminder(todos);
    const turnMessages: ChatMessage[] =
      reminder.length > 0 ? [...messages, { role: "user", content: reminder }] : messages;

    // `messages` is always balanced here (never ends on a dangling assistant tool_call), so a retry re-sends a
    // valid transcript without needing to scrub an orphan tail. Returns undefined when the caller aborts.
    const callModel = async (): Promise<StreamChatResult | undefined> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await streamChat({
            client: opts.client,
            model: opts.model,
            messages: [systemMessage(system), ...turnMessages],
            tools,
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
            onContentDelta: (delta) => emit({ type: "text_delta", delta }),
          });
        } catch (err) {
          if (opts.signal?.aborted) return undefined;
          if (attempt >= maxRetries || !isTransient(err)) {
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { detail: err instanceof Error ? err.message : String(err), attempts: attempt + 1 },
              "The model provider call failed.",
            );
          }
          await sleep(RETRY_BACKOFF_MS[attempt] ?? 1500, opts.signal);
          if (opts.signal?.aborted) return undefined;
        }
      }
    };
    const result = await callModel();
    if (!result) return finish("aborted", turn - 1);

    // The latest turn's total_tokens is the context footprint the MODEL saw; tool results appended after its turn are
    // added as an estimate (hybrid) before the budget check below.
    const usageTokens = result.usage?.total_tokens ?? budget.consumed;
    budget.consumed = usageTokens;

    // content is null (not "") when the turn is tool-calls-only — an empty string alongside tool_calls is
    // rejected by some providers (Anthropic via LiteLLM).
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content && result.content.length > 0 ? result.content : null,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    };
    messages = [...messages, assistant];
    const afterAssistantLen = messages.length; // tool results appended past here aren't in the model's usage count
    produced.push(assistant);
    if (result.content && result.content.length > 0) {
      finalText = result.content;
      emit({ type: "assistant_message", content: result.content });
    }
    await opts.onMessage?.(assistant);

    if (result.toolCalls.length === 0) return finish("end_turn", turn);

    const ctx: ToolContext = {
      selectedModel: opts.model,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    };
    const turnImages: ToolResultImage[] = []; // images returned by this turn's tools → one follow-up multimodal turn
    for (const tc of result.toolCalls) emit({ type: "tool_call", name: tc.function.name, args: tc.function.arguments });

    // Dispatch the turn's tool calls CONCURRENTLY (Claude Code parity — the model asks for independent tools together),
    // then append the results in call order so the assistant.tool_calls ↔ tool pairing stays ordered.
    const outputs: ToolResult[] = await Promise.all(
      result.toolCalls.map(async (tc): Promise<ToolResult> => {
        const tool = registry.get(tc.function.name);
        const parsed = parseArgs(tc.function.arguments);
        if (!tool) return { content: `Unknown tool: ${tc.function.name}`, isError: true };
        if (!parsed.ok) return { content: `Invalid JSON arguments: ${parsed.error}`, isError: true };
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
        return invokeTool(tool, parsed.value, ctx);
      }),
    );
    for (let i = 0; i < result.toolCalls.length; i++) {
      const tc = result.toolCalls[i];
      const output = outputs[i];
      if (!tc || !output) continue;
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: tc.id, content: capToolOutput(output.content) };
      messages = [...messages, toolMessage];
      produced.push(toolMessage);
      toolCalls.push({ name: tc.function.name, ok: !output.isError });
      if (output.images && output.images.length > 0) turnImages.push(...output.images);
      emit({ type: "tool_result", name: tc.function.name, isError: output.isError });
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

    // Hybrid budget: the model's reported usage + an estimate of everything appended since (tool results, image turn).
    budget.consumed = usageTokens + estimateTokens(messages.slice(afterAssistantLen));
    if (thresholdReached(budget)) {
      // Circuit breaker — don't hammer the summariser forever on an irrecoverably-oversized context.
      if (++compactionCount > MAX_COMPACTIONS) return finish("token_budget", turn);
      // Escalation ladder — try the cheapest, most information-preserving compaction first, stop only if none fit.
      // Rung 1: clear old tool-result bodies (deterministic; freed tokens surface in the next turn's usage).
      const micro = microcompact(messages);
      if (micro.cleared > 0) {
        messages = micro.messages;
        emit({ type: "compaction", mode: "microcompact", droppedMessages: 0 });
      } else {
        // Rung 2: LLM digest of the old span (goal/pending preserved). Rung 3: structural drop. Else: stop.
        // A summariser failure (upstream error) must not crash the run — fall through to the structural drop.
        let summarized = messages;
        try {
          summarized = await summarizeAndCompact(messages, summarize);
        } catch {
          summarized = messages;
        }
        if (summarized.length < messages.length) {
          emit({ type: "compaction", mode: "summarize", droppedMessages: messages.length - summarized.length });
          messages = summarized;
        } else {
          const dropped = compactMessages(messages);
          if (dropped.length < messages.length) {
            emit({ type: "compaction", mode: "drop", droppedMessages: messages.length - dropped.length });
            messages = dropped;
          } else {
            return finish("token_budget", turn);
          }
        }
      }
    }
  }

  return finish("max_turns", maxTurns);
}
