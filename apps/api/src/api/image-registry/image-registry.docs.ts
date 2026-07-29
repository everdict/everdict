import { ImageRegistryProbeResultSchema } from "@everdict/contracts/wire";
import { PushCredentialsResponseSchema } from "@everdict/contracts/wire";
import { ImageRegistryRosterSchema } from "@everdict/contracts/wire";
import { ImageRegistryUpsertResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

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
  probe: {
    summary: "Test a registry connection before registering",
    description:
      "Connection test — GET /v2/ against the host with the configured credential resolved from the SecretStore, " +
      "classified (reachable / auth / unreachable / error). Single-credential test: the push secret is preferred " +
      "(the `everdict image push` write path), else the pull secret, else an anonymous probe. Nothing is stored. A " +
      "classified failure is still a 200 (reason set, reachable=false). Requires settings:write (it resolves the workspace secret).",
    tags: ["image-registry"],
    body: toJsonSchema(
      z.object({
        host: z.string().min(1).describe("Registry host[:port] — not a URL (no scheme)"),
        namespace: z.string().min(1).optional(),
        username: z.string().min(1).optional().describe("docker login username (omit for token-only registries)"),
        pullSecretName: z.string().min(1).optional().describe("SecretStore name of the pull token/password"),
        pushSecretName: z.string().min(1).optional().describe("SecretStore name of the push token/password"),
      }),
    ),
    response: {
      200: { description: "Connection-test outcome", ...toJsonSchema(ImageRegistryProbeResultSchema) },
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
  tags: {
    summary: "List a repository's tags",
    description:
      "List the tags of a repository in a workspace image registry (Docker Registry v2) — powers the capability " +
      "wizard's environment image picker. ?registry= selects one when several are registered (omit with exactly one). " +
      "Standard bearer/basic registries (GHCR, Harbor, Docker Hub, generic v2); AWS ECR is unsupported. Requires harnesses:read.",
    tags: ["image-registry"],
    querystring: toJsonSchema(
      z.object({
        repository: z.string().describe('Repository path — "acme/api" · "library/node"'),
        registry: z.string().optional().describe("Registry name — required when several are registered"),
      }),
    ),
    response: {
      200: {
        description: "Repository tags",
        ...toJsonSchema(z.object({ registry: z.string(), repository: z.string(), tags: z.array(z.string()) })),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  manifest: {
    summary: "Inspect a repository manifest (digest resolution)",
    description:
      "Inspect a tag or digest of a repository — returns the digest (the recommended digest-pinned environment ref), " +
      "media type, and platforms/layer count. Same registry selection as tags. Requires harnesses:read.",
    tags: ["image-registry"],
    querystring: toJsonSchema(
      z.object({
        repository: z.string().describe("Repository path"),
        reference: z.string().describe('A tag or digest — "v1.2.0" · "sha256:…"'),
        registry: z.string().optional(),
      }),
    ),
    response: {
      200: {
        description: "Manifest summary",
        ...toJsonSchema(
          z.object({
            registry: z.string(),
            repository: z.string(),
            reference: z.string(),
            digest: z.string().optional(),
            mediaType: z.string().optional(),
            platforms: z.array(z.string()).optional(),
            layerCount: z.number().optional(),
          }),
        ),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  verify: {
    summary: "Verify that this workspace can pull an image ref",
    description:
      "Active pull-usability check for a FULL image ref (host/repo:tag or @digest): resolves the matching registered " +
      "registry's pull credential (anonymous when the host is not registered) and fetches the manifest. A failure is a " +
      "RESULT, not an error — {pullable:false, reason: auth|not-found|unreachable}. On success the resolved digest is " +
      "the recommended reproducible pin for an environment capability. Requires harnesses:read.",
    tags: ["image-registry"],
    querystring: toJsonSchema(
      z.object({ image: z.string().describe('Full image reference — "ghcr.io/acme/env:v3" · "…@sha256:…"') }),
    ),
    response: {
      200: {
        description: "Pull-usability outcome",
        ...toJsonSchema(
          z.object({
            pullable: z.boolean(),
            reason: z.enum(["ok", "auth", "not-found", "unreachable"]),
            digest: z.string().optional(),
          }),
        ),
      },
      ...errorResponses(400, 401, 403, 404),
    },
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
