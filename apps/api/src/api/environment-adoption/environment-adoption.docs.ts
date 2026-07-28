import { AdoptedEnvironmentViewSchema, AdoptedEnvironmentsResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for workspace environment-image adoption (import + pull-usability verification +
// inventory). Values are widened to FastifySchema so Fastify doesn't narrow reply.code() (rule api-layer: docs never
// validate/serialize). Design: docs/architecture/environment-image-store.md.
const adoptBody = toJsonSchema(
  z.object({
    source: z.string().min(1).describe("the publishing (owner) workspace of the environment capability"),
    id: z.string().min(1),
    version: z.string().min(1).describe("the immutable version to pin"),
  }),
);

const docs = {
  list: {
    summary: "List the workspace's adopted environment images",
    description:
      "The workspace's environment-image inventory — every adopted (imported) environment merged with its live " +
      "capability record (name/image/benchmark), a viewer-relative image classification, and the pull-usability " +
      "verification snapshot. `available:false` = the source capability was deleted or its reach revoked. Requires capabilities:read.",
    tags: ["environment-adoption"],
    response: {
      200: { description: "Adopted-environment inventory", ...toJsonSchema(AdoptedEnvironmentsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  adopt: {
    summary: "Adopt (import) an environment image into the workspace",
    description:
      "Import an environment capability into the workspace inventory, pinning the immutable version. On import the " +
      "image is verified for pull-usability against this workspace's registries (warn-not-block — the adoption is " +
      "recorded even if the image can't be pulled). Re-adopting the same (source,id) replaces the prior pin. An " +
      "unresolvable / non-consumable ref is 404. Requires settings:write.",
    tags: ["environment-adoption"],
    body: adoptBody,
    response: {
      200: {
        description: "The adopted environment (with verify status)",
        ...toJsonSchema(AdoptedEnvironmentViewSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  verify: {
    summary: "Re-verify an adopted environment's pull-usability",
    description:
      "Re-run the Docker Registry v2 pull check for one adopted environment and persist the fresh snapshot. Requires settings:write.",
    tags: ["environment-adoption"],
    body: toJsonSchema(z.object({ source: z.string().min(1), id: z.string().min(1) })),
    response: {
      200: {
        description: "The adopted environment (with refreshed verify status)",
        ...toJsonSchema(AdoptedEnvironmentViewSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  unadopt: {
    summary: "Remove an adopted environment from the workspace",
    description: "Removes the environment from the workspace inventory (by source + id). Requires settings:write.",
    tags: ["environment-adoption"],
    params: toJsonSchema(
      z.object({ source: z.string().describe("owner workspace"), id: z.string().describe("capability id") }),
    ),
    response: { 204: { description: "Removed", type: "null" }, ...errorResponses(401, 403, 404) },
  },
} satisfies Record<string, FastifySchema>;

export const environmentAdoptionDocs: Record<keyof typeof docs, FastifySchema> = docs;
