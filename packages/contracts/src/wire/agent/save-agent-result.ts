import { z } from "zod";

// PUT /agents/:id 200 — the human "save" upsert. Registration coordinates plus whether a NEW immutable version was
// written. created:false = the submitted spec was identical to the current latest (idempotent no-op — no version spam).
// Edits never mutate a version in place: a changed spec auto patch-bumps to a new immutable version so `latest` picks
// up the change while any conversation pinned to an older version stays reproducible.
export const SaveAgentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string().describe("The registered (or unchanged latest) version"),
  created: z.boolean().describe("True when a new immutable version was written; false = idempotent no-op"),
});
export type SaveAgentResult = z.infer<typeof SaveAgentResultSchema>;
