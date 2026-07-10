import { API_KEY_SCOPES } from "@everdict/auth";
import { ApiKeyMetaListResponseSchema } from "@everdict/contracts/wire";
import { CreatedApiKeyResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the personal API-key routes (doc-only — never validates/serializes; see api/openapi.ts).
// Self-serve and self-scoped (no role gate): each user sees/issues/revokes only their own keys; a key acts
// with the issuer's identity and permissions.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const apiKeyDocs: Record<"list" | "create" | "revoke", FastifySchema> = {
  list: {
    summary: "List my API keys",
    description:
      "Metadata only for the caller's own keys — never the plaintext or hash (prefix is an identification hint). Self-scoped, no role gate.",
    tags: ["api-key"],
    response: {
      200: { description: "My key metadata (newest first)", ...toJsonSchema(ApiKeyMetaListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  create: {
    summary: "Issue an API key",
    description:
      "Self-serve. The key is owned by the caller and acts with the caller's role; optional scopes narrow it " +
      "(intersection — never exceeds the role), Linear-style Full Access when omitted. The plaintext is returned exactly once " +
      "in this response; only the hash is stored.",
    tags: ["api-key"],
    body: toJsonSchema(
      z.object({
        label: z.string().max(80).optional().describe("Human label for the list"),
        scopes: z
          .array(z.enum(API_KEY_SCOPES))
          .optional()
          .describe("Narrowing scopes (read|write|admin); omitted = Full Access within the issuer's role"),
      }),
    ),
    response: {
      201: { description: "Plaintext API key (shown once)", ...toJsonSchema(CreatedApiKeyResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  revoke: {
    summary: "Revoke an API key",
    description:
      "Revokes only the caller's own key. Someone else's key, a machine key, or an unknown id is a no-op — always 204, no existence leak.",
    tags: ["api-key"],
    params: toJsonSchema(z.object({ id: z.string().describe("Key id (from the list metadata)") })),
    response: {
      204: { description: "Revoked (no content; also returned for unknown/foreign ids)" },
      ...errorResponses(401, 404),
    },
  },
};
