import type { TraceEvent } from "@everdict/contracts";

// The derived numbers of one sealed trajectory (E4 perception): pure arithmetic over the events — the
// threshold decorator compares these against the tenant's configured bounds. Extends usageFromTrace's
// LLM economics with the tool/error/latency axes an ops threshold actually watches.
export interface TrajectoryMetrics {
  usd: number;
  totalTokens: number;
  llmCalls: number;
  toolCalls: number;
  toolFailures: number;
  events: number;
  latencyMsMax: number;
}

export function trajectoryMetrics(trace: TraceEvent[]): TrajectoryMetrics {
  let usd = 0;
  let totalTokens = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let latencyMsMax = 0;
  for (const e of trace) {
    if (e.kind === "llm_call") {
      llmCalls += 1;
      if (e.cost) {
        usd += e.cost.usd;
        totalTokens += e.cost.inputTokens + e.cost.outputTokens;
      }
      if (e.latencyMs !== undefined && e.latencyMs > latencyMsMax) latencyMsMax = e.latencyMs;
    } else if (e.kind === "tool_call") {
      toolCalls += 1;
    } else if (e.kind === "tool_result") {
      if (!e.ok) toolFailures += 1;
    }
  }
  return { usd, totalTokens, llmCalls, toolCalls, toolFailures, events: trace.length, latencyMsMax };
}

// threshold.metric → the metric's value (the enum lives on WorkspaceSettings.traceThresholds).
export function trajectoryMetricValue(metrics: TrajectoryMetrics, metric: string): number | undefined {
  switch (metric) {
    case "usd":
      return metrics.usd;
    case "total_tokens":
      return metrics.totalTokens;
    case "llm_calls":
      return metrics.llmCalls;
    case "tool_calls":
      return metrics.toolCalls;
    case "tool_failures":
      return metrics.toolFailures;
    case "events":
      return metrics.events;
    case "latency_ms_max":
      return metrics.latencyMsMax;
    default:
      return undefined;
  }
}
