import { z } from "zod";

// Submit one ad-hoc test case into a live harness session (the playground). No dataset, no graders — the
// prompt IS the case; the service clamps the timeout to its max and refuses while another task runs (409).
export const SubmitSandboxTaskBodySchema = z.object({
  task: z.string().min(1).max(20_000),
  timeoutSec: z.number().int().positive().max(3600).optional(), // default 600
});
export type SubmitSandboxTaskBody = z.infer<typeof SubmitSandboxTaskBodySchema>;
