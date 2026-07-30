import { z } from "zod";

// Boot a sandbox session (execution-model P6): exactly one of `image` (ad-hoc, must be pullable by the
// control-plane's container runtime) or `environment` (an adopted environment capability — resolved to its
// image through the consume gate). ttlSec bounds the session's life; the service clamps it to its max.
export const CreateSandboxBodySchema = z
  .object({
    image: z.string().min(1).max(400).optional(),
    environment: z
      .object({
        source: z.string().min(1).optional(), // capability source workspace (default: the store's resolution order)
        id: z.string().min(1),
        version: z.string().min(1).optional(), // default "latest"
      })
      .optional(),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(4 * 3600)
      .optional(),
  })
  .refine((body) => (body.image !== undefined) !== (body.environment !== undefined), {
    message: "Provide exactly one of image or environment.",
  });
export type CreateSandboxBody = z.infer<typeof CreateSandboxBodySchema>;
