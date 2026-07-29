import { z } from "zod";
import { FsMergeResultSchema } from "../../records/workspace-file.js";
import { FsFileEncodingSchema } from "./fs-file-content.js";

// PUT /fs/file 409 `details` — what a write that lost a race gets back, sized so ONE round trip is enough to
// resolve: which revision the writer built on, which revision is live now, that live content, and (for text) the
// attempted three-way merge. The same payload serves both resolvers — the web renders the merge dialog from it,
// and an agent whose write_file returned CONFLICT can re-apply from `merge.merged` without re-reading the file.
export const FsWriteConflictSchema = z.object({
  path: z.string(),
  baseRevision: z.number().int().nonnegative(), // what the writer declared it edited (0 = "expected a new file")
  headRevision: z.number().int().nonnegative(), // what is actually published now
  head: z
    .object({
      content: z.string(),
      encoding: FsFileEncodingSchema,
      revision: z.number().int().positive(),
    })
    .optional(), // absent when the live file is unreadable (deleted mid-flight)
  merge: FsMergeResultSchema.optional(), // text-vs-text only; binary writes get no merge attempt
});
export type FsWriteConflict = z.infer<typeof FsWriteConflictSchema>;
