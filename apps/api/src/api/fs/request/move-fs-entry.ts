import { z } from "zod";

// POST /fs/move — rename/move a file or a whole directory subtree. The target must not exist (no overwrite).
export const MoveFsEntryBodySchema = z.object({
  from: z.string().min(1).max(600),
  to: z.string().min(1).max(600),
});
export type MoveFsEntryBody = z.infer<typeof MoveFsEntryBodySchema>;
