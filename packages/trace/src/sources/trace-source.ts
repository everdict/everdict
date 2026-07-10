import type { TraceEvent } from "@everdict/core";

// The source contract now lives in @everdict/contracts — re-architecture P2 compat re-export
// (removed in the P4 sweep). The Span IR + GenAI mapping below are parsing internals and stay here.
export type { TraceSource } from "@everdict/contracts";

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

// Span → TraceEvent. Based on the OTel GenAI semantic conventions (keys are adjustable to match the harness instrumentation).
export function spansToTraceEvents(spans: Span[]): TraceEvent[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const base = sorted[0]?.startMs ?? 0;
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s) continue;
    const t = s.startMs - base;
    const a = s.attrs;
    // OTel GenAI conventions (primary) + MLflow 3.x native (mlflow.chat.tokenUsage/mlflow.llm.model/.cost) fallback —
    // real MLflow 3.11 autolog traces carry tokens/model via mlflow.* even without gen_ai.* (live-verified).
    const tu = (a["mlflow.chat.tokenUsage"] ?? {}) as Record<string, unknown>;
    const llmCost = (a["mlflow.llm.cost"] ?? {}) as Record<string, unknown>;
    const model = str(a["gen_ai.request.model"]) ?? str(a["gen_ai.response.model"]) ?? str(a["mlflow.llm.model"]);
    const inTok = num(a["gen_ai.usage.input_tokens"]) ?? num(tu.input_tokens);
    const outTok = num(a["gen_ai.usage.output_tokens"]) ?? num(tu.output_tokens);
    const toolName = str(a["tool.name"]) ?? str(a["gen_ai.tool.name"]);

    if (model !== undefined || inTok !== undefined || outTok !== undefined) {
      out.push({
        t,
        kind: "llm_call",
        model: model ?? "",
        cost: {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          usd: num(a["gen_ai.usage.cost"]) ?? num(llmCost.total_cost) ?? 0,
        },
        latencyMs: s.endMs - s.startMs,
      });
    } else if (toolName !== undefined) {
      const id = str(a["tool.call_id"]) ?? `${s.name}-${i}`;
      out.push({ t, kind: "tool_call", id, name: toolName, args: a["tool.arguments"] });
      const ok = a["tool.error"] === undefined && a.error === undefined;
      out.push({ t: s.endMs - base, kind: "tool_result", id, ok, output: str(a["tool.result"]) ?? "" });
    } else {
      const text = str(a["message.content"]) ?? str(a["output.value"]);
      if (text !== undefined) out.push({ t, kind: "message", role: "assistant", text });
    }
  }
  return out;
}
