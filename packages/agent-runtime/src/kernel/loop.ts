import { UpstreamError } from "@everdict/contracts";
import type OpenAI from "openai";
import { compactMessages, microcompact, summarizeAndCompact } from "../context/compaction.js";
import { type TokenBudget, thresholdReached } from "../context/token-budget.js";
import { type StreamChatResult, streamChat } from "../llm/stream-chat.js";
import { buildSummarizer } from "../llm/summarize.js";
import { type ChatMessage, systemMessage } from "../messages.js";
import { extractDiscoveredToolNames } from "../tools/deferred.js";
import type { ToolContext } from "../tools/definition.js";
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
const DEFAULT_MAX_TOKENS = 900_000;
const DEFAULT_MAX_RETRIES = 2;
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
  const budget: TokenBudget = { maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS, consumed: 0 };
  // Rung-2 compaction summariser — the loop's own model by default (a one-shot digest), overridable for tests.
  const summarize = opts.summarize ?? buildSummarizer(opts.client, opts.model);
  const emit = (e: AgentEvent): void => opts.onEvent?.(e);

  let messages: ChatMessage[] = normalizeHistory(opts.history);
  // Goal persistence: the loop owns a todo list the model manages via write_todos, re-surfaced each turn as a
  // transient system-reminder so a long task stays on-goal. Seeded from a prior run in the same conversation.
  let todos: TodoItem[] = extractTodosFromHistory(messages);
  const registry = new ToolRegistry([...opts.registry.list(), buildTodoTool((t) => (todos = t))]);
  let finalText = "";
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

    // The latest turn's total_tokens is the current context footprint (prompt grows each turn) — a better budget
    // signal than a per-turn sum, which would double-count the carried-over context.
    budget.consumed = result.usage?.total_tokens ?? budget.consumed;

    // content is null (not "") when the turn is tool-calls-only — an empty string alongside tool_calls is
    // rejected by some providers (Anthropic via LiteLLM).
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content && result.content.length > 0 ? result.content : null,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    };
    messages = [...messages, assistant];
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
    for (const tc of result.toolCalls) {
      emit({ type: "tool_call", name: tc.function.name, args: tc.function.arguments });
      const tool = registry.get(tc.function.name);
      const parsed = parseArgs(tc.function.arguments);
      let output: { content: string; isError: boolean };
      if (!tool) {
        output = { content: `Unknown tool: ${tc.function.name}`, isError: true };
      } else if (!parsed.ok) {
        output = { content: `Invalid JSON arguments: ${parsed.error}`, isError: true };
      } else {
        output = await invokeTool(tool, parsed.value, ctx);
      }
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: tc.id, content: capToolOutput(output.content) };
      messages = [...messages, toolMessage];
      produced.push(toolMessage);
      toolCalls.push({ name: tc.function.name, ok: !output.isError });
      emit({ type: "tool_result", name: tc.function.name, isError: output.isError });
      await opts.onMessage?.(toolMessage);
    }

    if (thresholdReached(budget)) {
      // Escalation ladder — try the cheapest, most information-preserving compaction first, stop only if none fit.
      // Rung 1: clear old tool-result bodies (deterministic; freed tokens surface in the next turn's usage).
      const micro = microcompact(messages);
      if (micro.cleared > 0) {
        messages = micro.messages;
        emit({ type: "compaction", mode: "microcompact", droppedMessages: 0 });
      } else {
        // Rung 2: LLM digest of the old span (goal/pending preserved). Rung 3: structural drop. Else: stop.
        const summarized = await summarizeAndCompact(messages, summarize);
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
