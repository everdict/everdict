import { z } from "zod";

// Stop the delegate's current turn and leave it able to take the next one. The reason is optional and lands
// on the session's trajectory — a supervisor reading back six interrupts wants to know why each happened, and
// "the turn was aborted" without a reason is a record that explains nothing.
export const InterruptSandboxBodySchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
});
export type InterruptSandboxBody = z.infer<typeof InterruptSandboxBodySchema>;
