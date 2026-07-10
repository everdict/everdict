import type { RunUsageSummary, TraceEvent } from "@everdict/contracts";

// Trace → usage summary (derived rule) — the TraceEvent/RunUsageSummary shapes live in
// @everdict/contracts; the derivation lives here (single owner; the client never parses the trace).
// calls counts every llm_call; tokens/cost sum only those that have a cost.
export function usageFromTrace(trace: TraceEvent[]): RunUsageSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let usd = 0;
  let calls = 0;
  for (const e of trace) {
    if (e.kind !== "llm_call") continue;
    calls += 1;
    if (e.cost) {
      promptTokens += e.cost.inputTokens;
      completionTokens += e.cost.outputTokens;
      usd += e.cost.usd;
    }
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, usd, calls };
}
