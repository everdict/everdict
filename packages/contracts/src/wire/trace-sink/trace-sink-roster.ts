import { z } from "zod";
import { TraceSinkConfigViewSchema } from "./trace-sink-config-view.js";

// GET /workspace/trace-sinks — the registered sinks plus the per-harness selection map.
export const TraceSinkRosterSchema = z.object({
  sinks: z.array(TraceSinkConfigViewSchema),
  assignments: z
    .record(z.string())
    .describe("harness id → sink name. A harness with no entry is not exported (export is opt-in)"),
});
