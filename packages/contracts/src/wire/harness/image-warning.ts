import { z } from "zod";

// Image-classification warning (warn-not-block) — a local/unqualified image has no pull guarantee off the
// build machine. Mirrors ImageWarning (@everdict/contracts src/infra/image-ref.ts).
export const ImageWarningSchema = z.object({
  image: z.string().describe("The image reference as written in the resolved spec"),
  class: z.enum(["local", "unqualified"]).describe("Classification against the workspace image registries"),
});
export type ImageWarning = z.infer<typeof ImageWarningSchema>;
