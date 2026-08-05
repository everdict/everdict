import { z } from "zod";

// Close a sandbox session. `snapshot` overrides the session's hibernate default for this one teardown:
// false = close without saving a world snapshot, true = snapshot a session created without hibernate.
export const CloseSandboxBodySchema = z.object({
  snapshot: z.boolean().optional(),
});
export type CloseSandboxBody = z.infer<typeof CloseSandboxBodySchema>;
