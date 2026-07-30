import type { z } from "zod";
import { ImageInspectSchema } from "../../infra/image-store.js";

// GET /workspace/images/manifest — the inspect detail behind the Settings › Images drill-in: the digest to pin,
// plus (best-effort, depending on what the registry could resolve) the build recipe from the OCI config blob,
// the runtime configuration, and the size/platform summary. The schema itself lives with the store contracts
// (`ImageInspectSchema`) because the port returns the same shape; this file gives it the wire-response name the
// web mirrors and the OpenAPI docs attach.
// Design: docs/architecture/managed-image-store.md
export const ImageInspectResponseSchema = ImageInspectSchema;
export type ImageInspectResponse = z.infer<typeof ImageInspectResponseSchema>;
