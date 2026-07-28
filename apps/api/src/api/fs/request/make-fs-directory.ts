import { z } from "zod";

// POST /fs/directories — create a directory (idempotent, mkdir -p; ancestors become implicit).
export const MakeFsDirectoryBodySchema = z.object({
  path: z.string().min(1).max(600),
});
export type MakeFsDirectoryBody = z.infer<typeof MakeFsDirectoryBodySchema>;
