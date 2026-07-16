import { z } from "zod";
import { TraceSourceConfigViewSchema } from "./trace-source-config-view.js";

// GET /workspace/trace-sources — the ONE registered-source pool plus the two per-harness use-site maps
// (pull = which source a harness pulls its trace from; export = which source it exports judged results to).
export const TraceSourceRosterSchema = z.object({
  sources: z.array(TraceSourceConfigViewSchema),
  assignments: z
    .record(z.string())
    .describe("PULL: harness id → source name. No entry pulls from the inline spec.traceSource (or none)"),
  sinkAssignments: z
    .record(z.string())
    .describe("EXPORT: harness id → source name used as an export target. No entry is not exported (opt-in)"),
});
export type TraceSourceRoster = z.infer<typeof TraceSourceRosterSchema>;
