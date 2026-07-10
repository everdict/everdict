import { z } from "zod";
import { ImageRegistryViewSchema } from "./image-registry-view.js";

// GET /workspace/image-registries — every BYO registry registered on the workspace.
export const ImageRegistryRosterSchema = z.object({
  registries: z.array(ImageRegistryViewSchema),
});
