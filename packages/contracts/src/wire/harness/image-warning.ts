import { z } from "zod";

// Image-classification warning (warn-not-block) — a local/unqualified image has no pull guarantee off the build
// machine; a mutable-tag image (pullable but pinned by `latest`/untagged, no digest) is not reproducible. Mirrors
// ImageWarning (@everdict/contracts src/infra/image-ref.ts).
export const ImageWarningSchema = z.object({
  image: z.string().describe("The image reference as written in the resolved spec"),
  class: z
    .enum(["local", "unqualified", "mutable-tag"])
    .describe("Classification against the workspace image registries (+ reproducibility)"),
});
export type ImageWarning = z.infer<typeof ImageWarningSchema>;
