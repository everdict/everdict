import { z } from "zod";

// Boot a sandbox session (execution-model P6): exactly one of `image` (ad-hoc, must be pullable by the
// control-plane's container runtime), `environment` (an adopted environment capability — resolved to its
// image through the consume gate), or `harness` (a registered harness booted for interactive test cases —
// the playground; harness.image overrides/supplies the container image for specs that declare none).
// ttlSec bounds the session's life; the service clamps it to its max.
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
    harness: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(), // default "latest"
        image: z.string().min(1).max(400).optional(), // required when the spec declares no image (process kind)
      })
      .optional(),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(4 * 3600)
      .optional(),
  })
  .refine((body) => [body.image, body.environment, body.harness].filter((x) => x !== undefined).length === 1, {
    message: "Provide exactly one of image, environment, or harness.",
  });
export type CreateSandboxBody = z.infer<typeof CreateSandboxBodySchema>;
