import { z } from "zod";

// POST /runs/:id/exec — result of a one-shot `sh -c <command>` inside the run's live sandbox.
export const RunExecResponseSchema = z.object({
  found: z.boolean().describe("false = no live container to exec into (queued / finished / GC'd)"),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable().describe("Command exit code; null when found=false"),
});
export type RunExecResponse = z.infer<typeof RunExecResponseSchema>;
