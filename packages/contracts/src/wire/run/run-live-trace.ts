import { z } from "zod";
import { TraceEventSchema } from "../../execution/trace.js";
import { RunStatusSchema } from "../../records/run.js";

// GET /runs/:id/trajectory/live — the run's own TraceEvents accumulating while it runs (live-observability ⑨):
// the dispatch account's placement marks + runner-pushed batches + the managed job's event-sentinel stdout lines.
// A preview of the evidence that seals at settle, for poll-and-replace clients; the sealed trajectory
// (GET /runs/:id/trajectory) is the durable record.
export const RunLiveTraceResponseSchema = z.object({
  status: RunStatusSchema,
  found: z.boolean().describe("false = no live events have arrived yet (pre-dispatch / a lane with no live feed)"),
  events: z.array(TraceEventSchema).describe("Everything collected so far, dispatch marks first (snapshot semantics)"),
});
export type RunLiveTraceResponse = z.infer<typeof RunLiveTraceResponseSchema>;
