import { VersionTagsBodySchema } from "@everdict/application-control";
import { EnvironmentSpecSchema } from "@everdict/contracts";
import { EnvironmentListResponseSchema, RegisterEnvironmentResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetVersionTagsResultSchema } from "../runtime/response/set-version-tags-result.js";

// OpenAPI descriptors for the environment routes — doc-only (rule api-layer): the no-op compilers in
// server.ts make attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Environment id" },
    version: { type: "string", description: 'Environment version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register an environment version",
    description:
      "Registers a workspace-owned environment — the world a case ACTS ON (repo seed / browser fixture / " +
      "prompt context / desktop), as opposed to the harness that acts. A case names it with " +
      'env: { kind: "ref", id, version }, and the version a batch resolved is sealed on its manifest, so two ' +
      "batches over one dataset and two environment versions read as an environment confound rather than as a " +
      "change to the harness under test. Requires datasets:write — an environment is part of what an " +
      "evaluation asks, authored by whoever authors the cases. Versions are immutable (409 on collision).",
    tags: ["environment"],
    body: toJsonSchema(EnvironmentSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterEnvironmentResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  list: {
    summary: "List environments",
    description: "Environments visible to this workspace (owned + _shared), one entry per id. Requires datasets:read.",
    tags: ["environment"],
    response: {
      200: { description: "Environments", ...toJsonSchema(EnvironmentListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get an environment version",
    description: "A full EnvironmentSpec. version accepts \"latest\". Another workspace's or another team's reads 404.",
    tags: ["environment"],
    params: idVersionParams,
    response: {
      200: { description: "Environment", ...toJsonSchema(EnvironmentSpecSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace an environment version's tags",
    description: "Whole-array PUT (empty array = clear) — mutable metadata outside the spec. Reuses datasets:write.",
    tags: ["environment"],
    params: idVersionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: { description: "Tags", ...toJsonSchema(SetVersionTagsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const environmentDocs: Record<keyof typeof docs, FastifySchema> = docs;
