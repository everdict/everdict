import { z } from "zod";

// PUT /harnesses/:id/trace-source — the full per-harness selection map after the change.
export const TraceSourceAssignmentsResponseSchema = z.object({
  assignments: z.record(z.string()).describe("harness id → source name (the whole map after the update)"),
});
export type TraceSourceAssignmentsResponse = z.infer<typeof TraceSourceAssignmentsResponseSchema>;
