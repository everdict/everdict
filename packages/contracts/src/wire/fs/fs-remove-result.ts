import { z } from "zod";

// DELETE /fs/entry 200 — how many stored objects the removal deleted (files + empty-dir markers).
// `purgedRevisions` appears only on the whole-tree wipe (DELETE /fs), which also drops the workspace's
// publication history; deleting a single entry deliberately keeps its revisions (the content stays restorable).
export const FsRemoveResultSchema = z.object({
  removed: z.number().int().nonnegative(),
  purgedRevisions: z.number().int().nonnegative().optional(),
});
export type FsRemoveResult = z.infer<typeof FsRemoveResultSchema>;
