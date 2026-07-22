import { UpstreamError } from "@everdict/contracts";
import type OpenAI from "openai";
import { compactMessages } from "../context/compaction.js";
import { type TokenBudget, thresholdReached } from "../context/token-budget.js";
import { streamChat } from "../llm/stream-chat.js";
import { type ChatMessage, systemMessage } from "../messages.js";
import { extractDiscoveredToolNames } from "../tools/deferred.js";
import type { ToolContext } from "../tools/definition.js";
import { invokeTool } from "../tools/invocation.js";
import { toOpenAiTools } from "../tools/openai.js";
import type { ToolRegistry } from "../tools/registry.js";
import { normalizeHistory } from "./normalize.js";
import { buildSystemPrompt } from "./system-prompt.js";

export type StopReason = "end_turn" | "max_turns" | "token_budget" | "aborted";

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "compaction"; droppedMessages: number }
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
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
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

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOKENS = 900_000;

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
  const budget: TokenBudget = { maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS, consumed: 0 };
  const emit = (e: AgentEvent): void => opts.onEvent?.(e);

  let messages: ChatMessage[] = normalizeHistory(opts.history);
  const baseLen = messages.length;
  let finalText = "";
  const toolCalls: { name: string; ok: boolean }[] = [];

  const finish = (stopReason: StopReason, turns: number): AgentLoopResult => {
    emit({ type: "done", stopReason });
    return {
      content: finalText,
      stopReason,
      turns,
      tokensConsumed: budget.consumed,
      produced: messages.slice(baseLen),
      toolCalls,
    };
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) return finish("aborted", turn - 1);
    emit({ type: "turn_start", turn });

    const discovered = extractDiscoveredToolNames(messages);
    const tools = toOpenAiTools(opts.registry, discovered);
    const system = buildSystemPrompt(opts.systemPrompt, opts.registry, discovered);

    let result: Awaited<ReturnType<typeof streamChat>>;
    try {
      result = await streamChat({
        client: opts.client,
        model: opts.model,
        messages: [systemMessage(system), ...messages],
        tools,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        onContentDelta: (delta) => emit({ type: "text_delta", delta }),
      });
    } catch (err) {
      if (opts.signal?.aborted) return finish("aborted", turn - 1);
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { detail: err instanceof Error ? err.message : String(err) },
        "The model provider call failed.",
      );
    }

    budget.consumed += result.usage?.total_tokens ?? 0;

    const assistant: ChatMessage = {
      role: "assistant",
      content: result.content ?? "",
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    };
    messages = [...messages, assistant];
    if (result.content && result.content.length > 0) {
      finalText = result.content;
      emit({ type: "assistant_message", content: result.content });
    }

    if (result.toolCalls.length === 0) return finish("end_turn", turn);

    const ctx: ToolContext = {
      selectedModel: opts.model,
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    };
    for (const tc of result.toolCalls) {
      emit({ type: "tool_call", name: tc.function.name, args: tc.function.arguments });
      const tool = opts.registry.get(tc.function.name);
      const parsed = parseArgs(tc.function.arguments);
      let output: { content: string; isError: boolean };
      if (!tool) {
        output = { content: `Unknown tool: ${tc.function.name}`, isError: true };
      } else if (!parsed.ok) {
        output = { content: `Invalid JSON arguments: ${parsed.error}`, isError: true };
      } else {
        output = await invokeTool(tool, parsed.value, ctx);
      }
      messages = [...messages, { role: "tool", tool_call_id: tc.id, content: output.content }];
      toolCalls.push({ name: tc.function.name, ok: !output.isError });
      emit({ type: "tool_result", name: tc.function.name, isError: output.isError });
    }

    if (thresholdReached(budget)) {
      const compacted = compactMessages(messages);
      if (compacted.length < messages.length) {
        emit({ type: "compaction", droppedMessages: messages.length - compacted.length });
        messages = compacted;
      } else {
        return finish("token_budget", turn);
      }
    }
  }

  return finish("max_turns", maxTurns);
}
