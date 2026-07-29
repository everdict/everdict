import { z } from "zod";
import { ImageGrantSchema } from "../../infra/image-store.js";

// POST /workspace/images/push-grant — a short-lived authorization to push ONE repository in the workspace's
// managed namespace, plus the prefix the client needs to assemble the target ref. The two travel together
// because a caller cannot build the ref without the namespace, and cannot push without the grant.
// Design: docs/architecture/managed-image-store.md
export const ImagePushGrantResponseSchema = z.object({
  grant: ImageGrantSchema,
  imagePrefix: z.string().min(1), // "<endpoint>/<namespace>/" — prepend a name:tag to get the published ref
});
export type ImagePushGrantResponse = z.infer<typeof ImagePushGrantResponseSchema>;
