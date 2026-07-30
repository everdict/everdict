import {
  ImageCatalogResponseSchema,
  ImagePushGrantResponseSchema,
  ImageRemoveResponseSchema,
  ImageTagsResponseSchema,
} from "@everdict/contracts/wire";
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
  pushGrant: {
    summary: "Mint a push grant for a repository in the workspace's image namespace",
    description:
      "Short-lived authorization to push ONE repository in the caller's managed namespace, plus the prefix the " +
      "client assembles the target ref with. Requires images:push (member+) — the same member-gated action the " +
      "BYO push-credential mint uses, because the response IS a usable credential. The repository is created by " +
      "the first push. Design: docs/architecture/managed-image-store.md.",
    tags: ["images"],
    body: toJsonSchema(
      z.object({ repository: z.string().min(1).describe("Repository name inside the workspace namespace") }),
    ),
    response: {
      200: { description: "Push grant + image prefix", ...toJsonSchema(ImagePushGrantResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  catalog: {
    summary: "List the workspace's managed image repositories",
    description:
      "Every repository in the caller's managed namespace, plus the usage counters Settings › Images leads " +
      "with, plus the endpoint and namespace a ref is assembled from. Tags are NOT resolved here (one registry " +
      "call per repository) — drill in with the tags endpoint. Read is harnesses:read: which images a workspace " +
      "published is provenance, not a credential. Design: docs/architecture/managed-image-store.md.",
    tags: ["images"],
    response: {
      200: { description: "The workspace's repositories and usage", ...toJsonSchema(ImageCatalogResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  tags: {
    summary: "List the tags of one managed repository",
    description:
      "Tags of a single repository in the caller's namespace, resolved on demand — the drill-in the catalog " +
      "listing deliberately does not fan out. A repository that does not exist reads as an empty tag list, " +
      "matching the registry's own answer.",
    tags: ["images"],
    params: toJsonSchema(
      z.object({ repository: z.string().min(1).describe("Repository name inside the workspace namespace") }),
    ),
    response: {
      200: { description: "The repository's tags", ...toJsonSchema(ImageTagsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  remove: {
    summary: "Unpublish a repository from the workspace's image namespace",
    description:
      "Deletes every manifest of one repository in the caller's namespace and reports how many were unlinked " +
      "(blobs are reclaimed by the registry's own garbage collection). Requires images:push — retracting an " +
      "image is the inverse of publishing it, so it belongs to the same member who may push.",
    tags: ["images"],
    params: toJsonSchema(
      z.object({ repository: z.string().min(1).describe("Repository name inside the workspace namespace") }),
    ),
    response: {
      200: { description: "How many manifests were unlinked", ...toJsonSchema(ImageRemoveResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  manifest: {
    summary: "Inspect a manifest in the workspace's image namespace",
    description:
      "Manifest summary (digest, media type, platforms) for a tag or digest in the caller's namespace — the " +
      "authoritative digest to pin a just-pushed image by. Read is harnesses:read: provenance, not a credential.",
    tags: ["images"],
    querystring: toJsonSchema(
      z.object({ repository: z.string().min(1), reference: z.string().min(1).describe("Tag or digest") }),
    ),
    response: {
      200: {
        description: "Manifest summary",
        ...toJsonSchema(
          z.object({
            reference: z.string(),
            digest: z.string().optional(),
            mediaType: z.string().optional(),
            platforms: z.array(z.string()).optional(),
            layerCount: z.number().int().optional(),
          }),
        ),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} as const;

export const imagesDocs: Record<keyof typeof docs, FastifySchema> = docs;
