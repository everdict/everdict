import { z } from "zod";
import { FsTextDiffSchema } from "../../records/workspace-file.js";

// GET /fs/revisions/diff 200 — what changed between two revisions of one file. `to` comes back RESOLVED (the
// live revision when the caller compared against "now"), so a viewer can label the comparison without a second
// request. A binary or over-sized comparison arrives with `diff.truncated` and no hunks.
export const FsRevisionDiffSchema = z.object({
  path: z.string(),
  from: z.number().int().positive(),
  to: z.number().int().nonnegative(),
  diff: FsTextDiffSchema,
});
export type FsRevisionDiff = z.infer<typeof FsRevisionDiffSchema>;
