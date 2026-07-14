import { z } from "zod";
import { TraceSourceConfigViewSchema } from "./trace-source-config-view.js";

// GET /workspace/trace-sources — the registered sources plus the per-harness selection map.
export const TraceSourceRosterSchema = z.object({
  sources: z.array(TraceSourceConfigViewSchema),
  assignments: z
    .record(z.string())
    .describe("harness id → source name. A harness with no entry pulls from its inline spec.traceSource (or none)"),
});
export type TraceSourceRoster = z.infer<typeof TraceSourceRosterSchema>;
