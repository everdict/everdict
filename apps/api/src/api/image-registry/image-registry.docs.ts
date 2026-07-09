import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { PushCredentialsResponseSchema } from "./response/image-push-credentials.js";
import { ImageRegistryRosterSchema } from "./response/image-registry-roster.js";
import { ImageRegistryUpsertResultSchema } from "./response/image-registry-upsert-result.js";

// Doc-only OpenAPI descriptors for workspace image registries — BYO registries as the image-provenance
// baseline (rule api-layer: schemas document, never validate/serialize — the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  list: {
    summary: "List workspace image registries",
    description:
      "Every BYO registry registered on the workspace — the classification baseline for harness images " +
      "(workspace/external/local/unqualified) and the target roster for `everdict image push`. Read is " +
      "harnesses:read (viewer+ — name references/coordinates only, no secret values). " +
      "Design: docs/architecture/workspace-image-registry.md.",
    tags: ["image-registry"],
    response: {
      200: { description: "Registry roster", ...toJsonSchema(ImageRegistryRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  upsert: {
    summary: "Register or update an image registry",
    description:
      "Name-keyed upsert (declarative full replace — optional fields are removable). Secrets are SecretStore " +
      "name references; referenced-but-missing names come back as a missingSecrets warning (they can be added " +
      "later). Requires settings:write (admin) — unlike push-credential minting, which is member-gated.",
    tags: ["image-registry"],
    body: toJsonSchema(
      z.object({
        name: z.string().min(1).describe("Registry name (reference key)"),
        host: z.string().min(1).describe("Registry host[:port] — not a URL (no scheme)"),
        namespace: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
        pullSecretName: z.string().min(1).optional().describe("SecretStore name of the pull token/password"),
        pushSecretName: z.string().min(1).optional().describe("SecretStore name of the push token/password"),
      }),
    ),
    response: {
      200: {
        description: "Stored registry (+ missing-secret warning)",
        ...toJsonSchema(ImageRegistryUpsertResultSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Remove an image registry",
    description: "Removes the named registry from the workspace roster. Requires settings:write (admin).",
    tags: ["image-registry"],
    params: toJsonSchema(z.object({ name: z.string().describe("Registry name") })),
    response: { 204: { description: "Removed", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  pushCredentials: {
    summary: "Mint push credentials for a registry",
    description:
      "Returns the registry's push secret VALUE (one-time disclosure — consumed by `everdict image push` for a " +
      "transient docker login, never persisted). Select the registry via ?name=; omitting it is allowed only when " +
      "exactly one registry is registered (multiple without a name is 400, listing the names). Requires " +
      "images:push (member+ — value disclosure is named as its own action, not admin-gated settings:write).",
    tags: ["image-registry"],
    querystring: toJsonSchema(
      z.object({ name: z.string().optional().describe("Registry name — required when several are registered") }),
    ),
    response: {
      200: { description: "One-time push credentials", ...toJsonSchema(PushCredentialsResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const imageRegistryDocs: Record<keyof typeof docs, FastifySchema> = docs;
