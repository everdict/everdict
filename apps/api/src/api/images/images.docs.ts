import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for the managed image store (rule api-layer: schemas document, never
// validate/serialize). Design: docs/architecture/managed-image-store.md
const docs = {
  token: {
    summary: "Docker Registry v2 token endpoint (the managed registry's auth realm)",
    description:
      "Exchanges an image GRANT for a registry token. Called by a docker/containerd client, not by the web or " +
      "an agent: the managed registry challenges the client with this realm, the client presents its grant as " +
      "HTTP basic credentials (the grant is the password), and the token issued here authorizes the " +
      "intersection of the requested `scope` and what the grant already carried — a grant can be narrowed, " +
      "never widened. A valid grant with no scope succeeds with empty access (that is `docker login`). " +
      "No credential is 401. Design: docs/architecture/managed-image-store.md.",
    tags: ["images"],
    querystring: toJsonSchema(
      z.object({
        service: z.string().optional().describe("The registry service name the client was challenged with"),
        scope: z
          .string()
          .optional()
          .describe('Requested scope, repeatable — "repository:<namespace>/<name>:pull,push"'),
      }),
    ),
    response: {
      200: {
        description: "A registry token scoped to the granted access",
        ...toJsonSchema(
          z.object({
            token: z.string(),
            access_token: z.string(),
            expires_in: z.number().int(),
            issued_at: z.string(),
          }),
        ),
      },
      ...errorResponses(401, 404),
    },
  },
} as const;

export const imagesDocs: Record<keyof typeof docs, FastifySchema> = docs;
