import { z } from "zod";
import { ImageRegistryViewSchema } from "./image-registry-view.js";

// PUT /workspace/image-registries — the stored registry plus a warning for referenced-but-missing secret names
// (registration is allowed before the secrets exist; they can be added later).
export const ImageRegistryUpsertResultSchema = z.object({
  config: ImageRegistryViewSchema,
  missingSecrets: z
    .array(z.string())
    .optional()
    .describe("Referenced secret names not yet present in the workspace SecretStore (warning, not an error)"),
});
