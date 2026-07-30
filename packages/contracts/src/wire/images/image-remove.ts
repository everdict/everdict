import { z } from "zod";

// DELETE /workspace/images/:repository — how many manifests the registry actually unlinked. A count rather than
// 204: distribution deletes by manifest, so removing a repository is N deletions, and 0 is a meaningful answer
// (nothing matched) that a bare 204 would hide behind "success".
// Design: docs/architecture/managed-image-store.md
export const ImageRemoveResponseSchema = z.object({
  repository: z.string().min(1),
  removed: z.number().int().nonnegative(), // manifests unlinked; blobs are reclaimed by the registry's own GC
});
export type ImageRemoveResponse = z.infer<typeof ImageRemoveResponseSchema>;
