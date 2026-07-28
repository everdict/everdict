import { z } from "zod";

// DELETE /fs/entry 200 — how many stored objects the removal deleted (files + empty-dir markers).
export const FsRemoveResultSchema = z.object({ removed: z.number().int().nonnegative() });
export type FsRemoveResult = z.infer<typeof FsRemoveResultSchema>;
