import { SecretMetaListResponseSchema, SecretUsageListResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the secret routes (doc-only — never validates/serializes; see api/openapi.ts).
// Two scopes: workspace (shared, admin-managed via secrets:write) + user (personal, self-serve). Values are
// encrypted at rest and never read back — every response carries names/metadata only.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const secretDocs: Record<"list" | "usage" | "set" | "remove", FastifySchema> = {
  list: {
    summary: "List secret names",
    description:
      "Metadata only — never values. Any member may call it: personal (user-scope) entries always contain only the caller's own; " +
      "workspace (shared) names are included only for admins (secrets:read). Shared first, then personal, name-sorted.",
    tags: ["secret"],
    response: {
      200: {
        description: "Secret metadata (names + scopes, no values)",
        ...toJsonSchema(SecretMetaListResponseSchema),
      },
      ...errorResponses(401, 404),
    },
  },
  usage: {
    summary: "List workspace secrets with their usage sites",
    description:
      "Each workspace (shared) secret annotated with the live sites that reference it by name — harness env/trace, " +
      "runtime cluster/kubeconfig auth, a model's api-key, and settings integrations (Mattermost / image registries / " +
      "trace sources / egress proxies). Computed fresh from the current registry specs + settings (nothing cached), so a " +
      "removed reference disappears; a secret referenced nowhere returns refs=[] (an orphan). Admin-only (secrets:read).",
    tags: ["secret"],
    response: {
      200: {
        description: "Workspace secrets, each with its reference sites (no values)",
        ...toJsonSchema(SecretUsageListResponseSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  set: {
    summary: "Set a secret",
    description:
      "Upsert by name. scope=workspace (default) requires secrets:write (admin); scope=user is self-serve and owned by the caller. " +
      "The value is encrypted at rest and never returned again — 204, write-only.",
    tags: ["secret"],
    params: toJsonSchema(z.object({ name: z.string().describe("Secret name (env format ^[A-Z_][A-Z0-9_]*$)") })),
    body: toJsonSchema(
      z.object({
        value: z.string().min(1).describe("Plaintext secret value — stored encrypted, never read back"),
        scope: z
          .enum(["user", "workspace"])
          .default("workspace")
          .describe("workspace = shared (admin) · user = personal (self-serve)"),
      }),
    ),
    response: {
      204: { description: "Stored (no content — the value is never returned)" },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Delete a secret",
    description:
      "scope=user removes the caller's own personal secret (self-serve); any other/absent scope targets the shared workspace secret " +
      "and requires secrets:write (admin). Idempotent 204.",
    tags: ["secret"],
    params: toJsonSchema(z.object({ name: z.string().describe("Secret name") })),
    querystring: toJsonSchema(
      z.object({ scope: z.string().optional().describe('"user" = personal; anything else/absent = shared (admin)') }),
    ),
    response: {
      204: { description: "Deleted (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
};
