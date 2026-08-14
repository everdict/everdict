import type { TraceEvent } from "@everdict/contracts";

// ── THE JUDGE'S EXECUTION, IN THE VOCABULARY THE MEASUREMENT PLANE CANNOT MISREAD (report 1.1) ───────
//
// A judge's own calls become `span` events on the judged case's trace — named under the judge, carrying the
// model/usage/latency as ATTRIBUTES. Deliberately never `llm_call`: the cost/steps graders read that kind,
// so a judge's tokens recorded as one would bill the judged agent for the judgment. And deliberately
// re-timed by the CALLER to the trace's last instant, so the latency grader (which reads first/last `t`
// regardless of kind) measures the same execution before and after the judgment's evidence is attached.
export function judgeExecutionSpans(judgeId: string, events: TraceEvent[]): TraceEvent[] {
  const spans: TraceEvent[] = [];
  for (const e of events) {
    if (e.kind === "llm_call") {
      spans.push({
        t: e.t,
        kind: "span",
        name: `judge:${judgeId}:llm_call`,
        attributes: {
          model: e.model,
          ...(e.cost ? { inputTokens: e.cost.inputTokens, outputTokens: e.cost.outputTokens, usd: e.cost.usd } : {}),
          ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
        },
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      });
    } else if (e.kind === "message" && e.role === "assistant") {
      // The verdict text — what the judge actually said, truncated so a chatty judge cannot bloat the row.
      spans.push({
        t: e.t,
        kind: "span",
        name: `judge:${judgeId}:verdict`,
        attributes: { text: e.text.slice(0, 4_000) },
      });
    } else if (e.kind === "span") {
      // A dispatched judge's own structural spans keep their shape, renamed under the judge so they can
      // never satisfy another judge's declared `requires: [{kind:"span", name}]` by accident.
      spans.push({ ...e, name: `judge:${judgeId}:${e.name}` });
    }
    // Everything else (tool_call/log/error/infra of a dispatched judge's harness run) stays in the judge's
    // own sealed trajectory — the case's trace carries the judgment's essentials, not its transcript.
  }
  return spans;
}
