import { type TraceEvent, stamp } from "@everdict/contracts";

// --- Safe unknown-narrowing helpers (no any) ---
function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// Converts one line (JSON object) of Claude Code `--output-format stream-json --verbose`
// into normalized TraceEvent[]. Reusable by any stream-json harness. `now` is the event-time source:
// the real wall clock in production (so the trace aligns to the recording timeline and the latency grader
// reflects real elapsed time — see docs/architecture/replay.md D1); tests inject a deterministic one.
//
// Every event carries the contracts STRUCTURE the reader needs to draw this stream as what it is: `at` (the
// absolute instant `stamp` derives from the same clock `t` comes from) puts it on a real timeline, and the
// tool_use id becomes the call's `spanId` with its result hanging under it as `parentId` — so the trajectory
// reads as the tree the CLI actually emitted rather than a flat sequence of rows.
export function mapClaudeStreamJson(obj: unknown, now: () => number): TraceEvent[] {
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
        out.push({ ...stamp(now), kind: "message", role: "assistant", text: str(part.text) });
      } else if (pt === "tool_use") {
        const id = str(part.id);
        out.push({
          ...stamp(now),
          kind: "tool_call",
          id,
          name: str(part.name),
          args: part.input,
          // The call IS the span — its result nests under it. An unnamed call keeps no id rather than
          // minting one, so two anonymous calls never collapse into a single node.
          ...(id === "" ? {} : { spanId: id }),
        });
      }
    }
    const usage = msg ? rec(msg.usage) : null;
    if (usage) {
      out.push({
        ...stamp(now),
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
      const id = str(part.tool_use_id);
      out.push({
        ...stamp(now),
        kind: "tool_result",
        id,
        ok: part.is_error !== true,
        output: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
        ...(id === "" ? {} : { parentId: id }), // hangs under the call it answers
      });
    }
  } else if (type === "result") {
    const usd = num(o.total_cost_usd);
    if (usd !== undefined) {
      out.push({
        ...stamp(now),
        kind: "llm_call",
        model: "aggregate",
        cost: { inputTokens: 0, outputTokens: 0, usd },
      });
    }
  }
  return out;
}
