import { z } from "zod";

// PUT /harnesses/:id/trace-sink — the full per-harness selection map after the change.
export const TraceSinkAssignmentsResponseSchema = z.object({
  assignments: z.record(z.string()).describe("harness id → sink name (the whole map after the update)"),
});
export type TraceSinkAssignmentsResponse = z.infer<typeof TraceSinkAssignmentsResponseSchema>;
