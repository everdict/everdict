import { z } from "zod";

// Boot a sandbox session (execution-model P6): exactly one of `image` (ad-hoc, must be pullable by the
// control-plane's container runtime), `environment` (an adopted environment capability — resolved to its
// image through the consume gate), or `harness` (a registered harness booted for interactive test cases —
// the playground; harness.image overrides/supplies the container image for specs that declare none).
// Agent worlds (W1): `world` opens the session as a WORLD — boot its latest snapshot, or found it from
// `image` when it has no versions yet; `hibernate` (default true for world sessions) auto-snapshots at
// teardown. ttlSec bounds the session's life; the service clamps it to its max.
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
    world: z.object({ id: z.string().min(1).max(128) }).optional(),
    hibernate: z.boolean().optional(),
    // W2: clone a repository into the session before it is handed over. A private repo needs the workspace's
    // GitHub App installed on its owner; a public one clones anonymously.
    repo: z
      .object({
        git: z.string().url().max(1000),
        ref: z.string().min(1).max(255).optional(),
        dir: z.string().min(1).max(512).optional(), // default "work"
      })
      .optional(),
    // W4: place the session on a runtime this workspace registered (the same axis a run's placement.target
    // names). Unset = the deployment's default compute.
    runtime: z.string().min(1).max(200).optional(),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(4 * 3600)
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (
      body.repo !== undefined &&
      body.image === undefined &&
      body.environment === undefined &&
      body.world === undefined &&
      body.harness === undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repo clones INTO a session — also provide image, environment, harness, or world.",
      });
    if (body.world !== undefined) {
      if (body.environment !== undefined || body.harness !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "world combines only with image (its genesis base) — not with environment or harness.",
        });
      return;
    }
    if ([body.image, body.environment, body.harness].filter((x) => x !== undefined).length !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of image, environment, or harness.",
      });
  });
export type CreateSandboxBody = z.infer<typeof CreateSandboxBodySchema>;
