import { z } from "zod";
import { FsEntryKindSchema } from "../../records/workspace-file.js";

// GET /fs/usage 200 — the workspace filesystem's storage picture (Settings › Files): totals + a per-top-level
// breakdown. `truncated` = the sweep hit its walk cap, so counts are a floor rather than the exact total.
export const FsUsageTopLevelSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: FsEntryKindSchema,
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export const FsUsageSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  topLevel: z.array(FsUsageTopLevelSchema),
  // Published history's own footprint. The tree walk above cannot see it (revision blobs live outside the tree)
  // and retention is unlimited, so on an actively-edited workspace this outgrows `bytes` — reporting it keeps
  // "what this workspace stores" honest. Absent when the deployment has no revision ledger.
  history: z.object({ revisions: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).optional(),
});
export type FsUsage = z.infer<typeof FsUsageSchema>;
export type FsUsageTopLevel = z.infer<typeof FsUsageTopLevelSchema>;
