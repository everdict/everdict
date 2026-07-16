import type { SpanAttrMapping, TraceEvent } from "@everdict/contracts";

// The shared intermediate-representation span for OTel/MLflow.
export interface Span {
  name: string;
  startMs: number;
  endMs: number;
  attrs: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// The built-in OTel GenAI + MLflow-native default attribute keys per TraceEvent field. A harness that emits these
// needs no mapping; a harness that doesn't supplies a SpanAttrMapping whose keys are tried FIRST (see spansToTraceEvents).
const DEFAULT_KEYS = {
  model: ["gen_ai.request.model", "gen_ai.response.model", "mlflow.llm.model"],
  inputTokens: ["gen_ai.usage.input_tokens"],
  outputTokens: ["gen_ai.usage.output_tokens"],
  costUsd: ["gen_ai.usage.cost"],
  toolName: ["tool.name", "gen_ai.tool.name"],
  toolCallId: ["tool.call_id"],
  toolArgs: ["tool.arguments"],
  toolResult: ["tool.result"],
  messageText: ["message.content", "output.value"],
} as const;

// First defined string among a field's mapping-override keys then its defaults.
function pickStr(a: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function pickNum(a: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = num(a[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
function firstDefined(a: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (a[k] !== undefined) return a[k];
  return undefined;
}

// Span → TraceEvent. Defaults to the OTel GenAI semantic conventions; a per-harness SpanAttrMapping overrides the
// attribute keys (tried first, then the defaults) so a harness with non-standard instrumentation still normalizes.
export function spansToTraceEvents(spans: Span[], mapping?: SpanAttrMapping): TraceEvent[] {
  const keys = {
    model: [...(mapping?.model ?? []), ...DEFAULT_KEYS.model],
    inputTokens: [...(mapping?.inputTokens ?? []), ...DEFAULT_KEYS.inputTokens],
    outputTokens: [...(mapping?.outputTokens ?? []), ...DEFAULT_KEYS.outputTokens],
    costUsd: [...(mapping?.costUsd ?? []), ...DEFAULT_KEYS.costUsd],
    toolName: [...(mapping?.toolName ?? []), ...DEFAULT_KEYS.toolName],
    toolCallId: [...(mapping?.toolCallId ?? []), ...DEFAULT_KEYS.toolCallId],
    toolArgs: [...(mapping?.toolArgs ?? []), ...DEFAULT_KEYS.toolArgs],
    toolResult: [...(mapping?.toolResult ?? []), ...DEFAULT_KEYS.toolResult],
    messageText: [...(mapping?.messageText ?? []), ...DEFAULT_KEYS.messageText],
  };
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const base = sorted[0]?.startMs ?? 0;
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s) continue;
    const t = s.startMs - base;
    const a = s.attrs;
    // MLflow 3.x native token/cost live in nested objects (mlflow.chat.tokenUsage/mlflow.llm.cost) — kept as a fallback
    // after the mapping+GenAI keys, since real MLflow 3.11 autolog traces carry them there even without gen_ai.* (live-verified).
    const tu = (a["mlflow.chat.tokenUsage"] ?? {}) as Record<string, unknown>;
    const llmCost = (a["mlflow.llm.cost"] ?? {}) as Record<string, unknown>;
    const model = pickStr(a, keys.model);
    const inTok = pickNum(a, keys.inputTokens) ?? num(tu.input_tokens);
    const outTok = pickNum(a, keys.outputTokens) ?? num(tu.output_tokens);
    const toolName = pickStr(a, keys.toolName);

    if (model !== undefined || inTok !== undefined || outTok !== undefined) {
      out.push({
        t,
        kind: "llm_call",
        model: model ?? "",
        cost: {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          usd: pickNum(a, keys.costUsd) ?? num(llmCost.total_cost) ?? 0,
        },
        latencyMs: s.endMs - s.startMs,
      });
    } else if (toolName !== undefined) {
      const id = pickStr(a, keys.toolCallId) ?? `${s.name}-${i}`;
      out.push({ t, kind: "tool_call", id, name: toolName, args: firstDefined(a, keys.toolArgs) });
      const ok = a["tool.error"] === undefined && a.error === undefined;
      out.push({ t: s.endMs - base, kind: "tool_result", id, ok, output: pickStr(a, keys.toolResult) ?? "" });
    } else {
      const text = pickStr(a, keys.messageText);
      if (text !== undefined) out.push({ t, kind: "message", role: "assistant", text });
    }
  }
  return out;
}
