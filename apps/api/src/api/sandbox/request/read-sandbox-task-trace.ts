import { z } from "zod";

// The 2s poll cursor: events since an index into the task's append-only buffer. Omitted/0 = full replay
// (how a remounted panel reconstructs the feed). After settle the sealed trajectory serves the same slice.
export const ReadSandboxTaskTraceQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
});
export type ReadSandboxTaskTraceQuery = z.infer<typeof ReadSandboxTaskTraceQuerySchema>;
