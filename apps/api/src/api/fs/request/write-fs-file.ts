import { z } from "zod";

// PUT /fs/file — publish a revision of a file on the workspace filesystem. Paths are normalized server-side
// (leading "/" and "./" accepted; traversal rejected). `content` carries utf8 text by default; pass
// encoding "base64" for binary. The cap covers base64 of the 5 MiB per-file limit.
//
// `baseRevision` is the optimistic lock every collaborative editor should send: the revision the author actually
// edited (0 = "I expect to create this file"). If anything was published since, the write is refused with 409 +
// the merge kit instead of overwriting a teammate's or an agent's work. Omitting it means "publish regardless".
export const WriteFsFileBodySchema = z.object({
  path: z.string().min(1).max(600),
  content: z.string().max(7_200_000),
  encoding: z.enum(["utf8", "base64"]).optional(),
  contentType: z.string().min(1).max(200).optional(),
  baseRevision: z.number().int().nonnegative().optional(),
  message: z.string().max(500).optional(), // why this revision was published (shown in the file's history)
});
export type WriteFsFileBody = z.infer<typeof WriteFsFileBodySchema>;
