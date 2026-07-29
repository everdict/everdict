import { z } from "zod";

// GET /workspace/adopted-environments — the workspace's environment-image inventory. Each item merges the adoption
// REF (WorkspaceSettings.adoptedEnvironments) with the LIVE capability record (name/image/benchmark), a FRESH
// viewer-relative image classification, and the stored pull-usability verify snapshot. `available` is false when the
// source capability was deleted or its reach revoked (the pin no longer resolves for this workspace). Design:
// docs/architecture/environment-image-store.md.

// Pull-usability snapshot: can THIS workspace pull the image? Taken at adopt / re-verify time (warn-not-block).
export const AdoptedEnvironmentVerifySchema = z.object({
  pullable: z.boolean(),
  reason: z.enum(["ok", "auth", "not-found", "unreachable"]).optional(),
  digest: z.string().optional(),
  at: z.string().describe("ISO timestamp of the check"),
});
export type AdoptedEnvironmentVerify = z.infer<typeof AdoptedEnvironmentVerifySchema>;

export const AdoptedEnvironmentViewSchema = z.object({
  source: z.string().describe("the publishing (owner) workspace of the environment capability"),
  id: z.string(),
  version: z.string(),
  adoptedAt: z.string(),
  available: z.boolean().describe("the source capability still resolves + is consumable for this workspace"),
  name: z.string().optional(), // from the capability record (absent when unavailable)
  image: z.string().optional(),
  benchmark: z.string().optional(),
  imageClass: z.enum(["managed", "workspace", "external", "local", "unqualified"]).optional(),
  verify: AdoptedEnvironmentVerifySchema.optional(),
});
export type AdoptedEnvironmentView = z.infer<typeof AdoptedEnvironmentViewSchema>;

export const AdoptedEnvironmentsResponseSchema = z.object({
  environments: z.array(AdoptedEnvironmentViewSchema),
});
export type AdoptedEnvironmentsResponse = z.infer<typeof AdoptedEnvironmentsResponseSchema>;
