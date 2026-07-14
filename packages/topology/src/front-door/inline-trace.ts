import { InternalError, type TraceEvent, TraceEventSchema } from "@everdict/contracts";
import { getField } from "./front-door-driver.js";

// The inline-trace channel — the trace sibling of the sentinel observation (observation-source.ts). When a service
// harness declares frontDoor.traceInline, the agent returned its step trace as a NORMALIZED TraceEvent[] inside the
// front-door response body, so the judge sees the agent's action steps WITHOUT an external observability platform
// (otel/mlflow). With a path, the array is read via dot-path; without one, the whole body is the array.
// Design: docs/service-harness.md (inline trace).

// Extract + validate the inline TraceEvent[] from the front-door response. Each element is validated against the
// normalized TraceEvent schema; a format mismatch fails explicitly (external-contract error) rather than silently
// yielding an empty trace — the caller (service-backend) records it as a NON-fatal trace error, since the trace is
// secondary to the browser snapshot (same policy as a trace-fetch failure).
export function extractInlineTrace(response: unknown, path: string | undefined): TraceEvent[] {
  const raw = path ? getField(response, path) : response;
  const label = path ?? "response body";
  if (!Array.isArray(raw)) {
    throw new InternalError(
      "HARNESS_RUN_FAILED",
      { path: label },
      `inline trace (${label}) is not a normalized TraceEvent[] (expected an array).`,
    );
  }
  const events: TraceEvent[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const parsed = TraceEventSchema.safeParse(raw[idx]);
    if (!parsed.success) {
      throw new InternalError(
        "HARNESS_RUN_FAILED",
        { path: label, index: idx, issues: parsed.error.issues.slice(0, 4).map((i) => i.message) },
        `inline trace (${label})[${idx}] is not a normalized TraceEvent.`,
      );
    }
    events.push(parsed.data);
  }
  return events;
}
