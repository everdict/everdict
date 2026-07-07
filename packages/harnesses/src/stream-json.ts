import type { TraceEvent } from "@everdict/core";

// --- 안전한 unknown 내로잉 헬퍼 (any 금지) ---
function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// Claude Code `--output-format stream-json --verbose`의 한 줄(JSON 객체)을
// 정규화 TraceEvent[]로 변환한다. 어떤 stream-json 하니스든 재사용 가능.
export function mapClaudeStreamJson(obj: unknown, nextT: () => number): TraceEvent[] {
  const o = rec(obj);
  if (!o) return [];
  const out: TraceEvent[] = [];
  const type = str(o.type);

  if (type === "assistant") {
    const msg = rec(o.message);
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const partU of content) {
      const part = rec(partU);
      if (!part) continue;
      const pt = str(part.type);
      if (pt === "text") {
        out.push({ t: nextT(), kind: "message", role: "assistant", text: str(part.text) });
      } else if (pt === "tool_use") {
        out.push({ t: nextT(), kind: "tool_call", id: str(part.id), name: str(part.name), args: part.input });
      }
    }
    const usage = msg ? rec(msg.usage) : null;
    if (usage) {
      out.push({
        t: nextT(),
        kind: "llm_call",
        model: msg ? str(msg.model) : "",
        cost: { inputTokens: num(usage.input_tokens) ?? 0, outputTokens: num(usage.output_tokens) ?? 0, usd: 0 },
      });
    }
  } else if (type === "user") {
    const msg = rec(o.message);
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const partU of content) {
      const part = rec(partU);
      if (!part || str(part.type) !== "tool_result") continue;
      out.push({
        t: nextT(),
        kind: "tool_result",
        id: str(part.tool_use_id),
        ok: part.is_error !== true,
        output: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
      });
    }
  } else if (type === "result") {
    const usd = num(o.total_cost_usd);
    if (usd !== undefined) {
      out.push({ t: nextT(), kind: "llm_call", model: "aggregate", cost: { inputTokens: 0, outputTokens: 0, usd } });
    }
  }
  return out;
}
