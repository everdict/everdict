import { z } from "zod";

// PUT /fs/file — create-or-replace a file on the workspace filesystem. Paths are normalized server-side
// (leading "/" and "./" accepted; traversal rejected). `content` carries utf8 text by default; pass
// encoding "base64" for binary. The cap covers base64 of the 5 MiB per-file limit.
export const WriteFsFileBodySchema = z.object({
  path: z.string().min(1).max(600),
  content: z.string().max(7_200_000),
  encoding: z.enum(["utf8", "base64"]).optional(),
  contentType: z.string().min(1).max(200).optional(),
});
export type WriteFsFileBody = z.infer<typeof WriteFsFileBodySchema>;
