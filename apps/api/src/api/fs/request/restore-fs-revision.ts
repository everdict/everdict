import { z } from "zod";

// POST /fs/revisions/restore — bring back an earlier revision's content. This does not rewind history: it
// PUBLISHES those bytes as a new revision attributed to the caller, so the rollback is itself auditable.
export const RestoreFsRevisionBodySchema = z.object({
  path: z.string().min(1).max(600),
  revision: z.number().int().positive(),
});
export type RestoreFsRevisionBody = z.infer<typeof RestoreFsRevisionBodySchema>;
