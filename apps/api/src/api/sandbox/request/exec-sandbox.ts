import { z } from "zod";

// One shell command into a live sandbox session (`sh -c`). The service enforces creator-or-admin BEFORE
// anything runs — attach is not a read.
export const ExecSandboxBodySchema = z.object({
  command: z.string().min(1).max(10_000),
  timeoutSec: z.number().int().positive().max(600).optional(),
});
export type ExecSandboxBody = z.infer<typeof ExecSandboxBodySchema>;
