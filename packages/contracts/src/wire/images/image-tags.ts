import { z } from "zod";

// GET /workspace/images/:repository/tags — the tags of ONE repository, resolved on demand. The catalog listing
// deliberately does not fan out tags (one registry call per repository), so this is the drill-in.
// `repository` is echoed because the MCP tool's result is read by a model with no memory of the request path.
// Design: docs/architecture/managed-image-store.md
export const ImageTagsResponseSchema = z.object({
  repository: z.string().min(1), // the name inside the workspace namespace, as requested
  tags: z.array(z.string()),
});
export type ImageTagsResponse = z.infer<typeof ImageTagsResponseSchema>;
