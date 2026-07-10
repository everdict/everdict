import { z } from "zod";
import { RunRecordSchema } from "../../records/run.js";

// GET /runs/:id — the record plus a best-effort live-trace deep link while the run is in flight
// (LiveTraceRef, see core/run/run-service.ts).
export const LiveTraceRefSchema = z.object({
  kind: z.string().describe("Trace platform kind (otel | mlflow | langfuse | langsmith | phoenix)"),
  endpoint: z.string().describe("Platform endpoint from the harness spec (UI entry point, best-effort)"),
  runId: z.string().describe("Correlation value (everdict.run_id tag / trace search key)"),
});

export const RunDetailResponseSchema = RunRecordSchema.extend({
  liveTrace: LiveTraceRefSchema.optional().describe(
    "Live trace deep-link coordinates — present only while the run is observable on the tenant's trace platform",
  ),
});
