import { z } from "zod";

// Keep-alive (touch): push the session's hard deadline out to now+ttl — the service clamps to its max and
// never pulls a deadline IN (a touch cannot shorten a session).
export const TouchSandboxBodySchema = z.object({
  ttlSec: z
    .number()
    .int()
    .positive()
    .max(4 * 3600)
    .optional(),
});
export type TouchSandboxBody = z.infer<typeof TouchSandboxBodySchema>;
