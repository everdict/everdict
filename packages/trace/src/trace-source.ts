import type { TraceEvent } from "@assay/core";

// 하니스가 OTel/MLflow 로 내보낸 한 run 의 트레이스를 끌어와 정규화 TraceEvent[] 로 돌려준다.
export interface TraceSource {
  fetch(runId: string): Promise<TraceEvent[]>;
}

// OTel/MLflow 공통 중간표현 스팬.
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

// 스팬 → TraceEvent. OTel GenAI semantic conventions 기반(하니스 계측에 맞춰 키는 보정 가능).
export function spansToTraceEvents(spans: Span[]): TraceEvent[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const base = sorted[0]?.startMs ?? 0;
  const out: TraceEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s) continue;
    const t = s.startMs - base;
    const a = s.attrs;
    // OTel GenAI conventions(주) + MLflow 3.x 네이티브(mlflow.chat.tokenUsage/mlflow.llm.model/.cost) 폴백 —
    // 실 MLflow 3.11 autolog 트레이스는 gen_ai.* 없이도 mlflow.* 로 토큰/모델을 싣는다(라이브 검증).
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
