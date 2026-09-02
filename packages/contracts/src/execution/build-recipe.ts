import { z } from "zod";

// ── HOW BYTES ARE PRODUCED FROM A SOURCE, FOR ANYTHING THAT HAS BYTES ────────────────────────────────
//
// A harness slot's image and an ENVIRONMENT's image are produced the same way — clone a repository, run
// steps in a base image, capture paths — and the recipe was declared on the harness template because that
// was the only thing with bytes. Now that a versioned world carries its own image
// (`docs/architecture/world-and-engagement-model.md`), the recipe has two subjects, and a schema written
// twice has already diverged (rule `protocol` L3).
//
// It lives under `execution/` rather than `harness/` because it belongs to neither: `harness/harness.ts`
// already imports from `execution/`, so putting a shared shape the other way round would close a cycle.
// `harness-template.ts` re-exports these under their historical names, so no consumer moved.

// WHO maintains this code (docs/architecture/evolution-routing-spec.md §1): the delegation profile — the coding
// agent built for THIS repository, its instructions file, its tool conventions, its model. It lives on the
// source because the source is the SSOT of "this code, built this way"; a workspace-level repository → profile
// map would be a second owner of a fact the declaration already half-owns, and drift the moment a repository moves.
export const MaintainerSchema = z.object({
  profile: z.string().min(1), // a delegation profile id (CapabilityRecord of type `delegation`)
  version: z.string().min(1).optional(), // pin a profile version; absent = the workspace's current one
});
export type Maintainer = z.infer<typeof MaintainerSchema>;

export const SourceRecipeSchema = z.object({
  git: z.string().min(1), // the clone URL (a private repository needs the workspace GitHub App on its owner)
  repo: z.string().min(1).optional(), // "owner/name", when the URL is a GitHub repository — the pull-request coordinate
  maintainer: MaintainerSchema.optional(),
});
export type SourceRecipe = z.infer<typeof SourceRecipeSchema>;

export const BuildRecipeSchema = z.object({
  steps: z.array(z.string().min(1)).min(1), // run in order, in workDir, inside the base image
  // Absolute, because the capture is a tar of paths from `/` and the clone lands here. Default: a directory the
  // base image is unlikely to own, so the layer carries the build and nothing the base already had.
  workDir: z.string().min(1).regex(/^\//, "build.workDir must be an absolute path").default("/everdict/build"),
  capture: z.array(z.string().min(1).regex(/^\//, "capture paths must be absolute")).optional(), // default [workDir]
  timeoutSec: z.number().int().positive().max(7200).optional(), // the whole build's bound (default 1800)
});
export type BuildRecipe = z.infer<typeof BuildRecipeSchema>;
