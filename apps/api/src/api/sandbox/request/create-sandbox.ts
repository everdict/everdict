import { DelegationBriefSchema } from "@everdict/contracts";
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
    // A DELEGATION PROFILE (a `delegation` capability): the registered work environment everdict hands work to
    // — one reference instead of re-specifying the image, the model connection, the env and the instructions
    // every time. Always a conversation; `brief` is the structured handoff that comes with it.
    profile: z
      .object({
        source: z.string().min(1).optional(), // the owning workspace (default: this one, then the shared tiers)
        id: z.string().min(1),
        version: z.string().min(1).optional(), // default "latest"
      })
      .optional(),
    brief: DelegationBriefSchema.optional(),
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
        // Conversation mode: every submitted task continues ONE conversation (stable workdir + the harness's
        // resume mechanism) instead of running independent cases. Refused (400) when the harness cannot resume.
        conversation: z.boolean().optional(),
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
    // `profile` is the WHO axis, not a boot mode: it overlays whichever target the caller named (a plain
    // image, an adopted environment, a world, or a world's genesis) and stands alone when they named none.
    // The one conflict is `harness`, which also says who runs.
    if (body.profile !== undefined && body.harness !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "profile and harness both say WHO runs — provide one (a profile already pins its own agent).",
      });
    if (body.brief !== undefined && body.profile === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "brief is the handoff to a delegation profile — also provide profile:{id}.",
      });
    if (
      body.repo !== undefined &&
      body.image === undefined &&
      body.environment === undefined &&
      body.world === undefined &&
      body.harness === undefined &&
      body.profile === undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repo clones INTO a session — also provide image, environment, harness, profile, or world.",
      });
    if (body.world !== undefined) {
      if (body.environment !== undefined || body.harness !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "world combines only with image (its genesis base) or profile — not with environment or harness.",
        });
      return;
    }
    if (body.profile !== undefined) {
      // With a profile the target is optional (its own image is the default), but naming two is ambiguous.
      if (body.image !== undefined && body.environment !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide at most one of image or environment alongside profile.",
        });
      return;
    }
    if ([body.image, body.environment, body.harness].filter((x) => x !== undefined).length !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of image, environment, harness, or profile.",
      });
  });
export type CreateSandboxBody = z.infer<typeof CreateSandboxBodySchema>;
