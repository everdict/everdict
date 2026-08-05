import { z } from "zod";

// Snapshot a world session (agent worlds W1): publish the session's filesystem as the world's next
// environment-capability version. All fields optional — prose carries forward from the world's latest
// version when omitted, so a bare snapshot never blanks out what the author wrote.
export const SnapshotSandboxBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  instructions: z.string().min(1).max(20_000).optional(),
});
export type SnapshotSandboxBody = z.infer<typeof SnapshotSandboxBodySchema>;
