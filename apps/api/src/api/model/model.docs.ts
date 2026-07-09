import { ModelSpecSchema } from "@everdict/core";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { ModelListResponseSchema } from "./response/model-list-entry.js";
import { ModelResponseSchema } from "./response/model.js";
import { RegisterModelResultSchema } from "./response/register-model-result.js";
import { ValidateModelResultSchema } from "./response/validate-model-result.js";

// OpenAPI descriptors for the model routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Model id" },
    version: { type: "string", description: 'Model version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a model version",
    description:
      "Registers a workspace-owned model definition (provider + underlying model + baseUrl) for inference/judging. " +
      "Requires models:write (member+). Versions are immutable — re-registering the same (id, version) with " +
      "different content is 409. Reads resolve workspace-owned first with a _shared (first-party) fallback.",
    tags: ["model"],
    body: toJsonSchema(ModelSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterModelResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a model spec",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, " +
      "without registering. Requires models:write (member+). Validation failures are reported as ok:false in a " +
      "200 response, not as 4xx.",
    tags: ["model"],
    body: toJsonSchema(ModelSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateModelResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List models",
    description:
      "Lists this workspace's models plus _shared first-party entries (workspace-owned first, _shared fallback). " +
      "Requires models:read (viewer+).",
    tags: ["model"],
    response: {
      200: { description: "Model list entries", ...toJsonSchema(ModelListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a model version",
    description:
      'The full ModelSpec for one version. version may be "latest" (semver-latest). Requires models:read ' +
      "(viewer+). Another workspace's model reads 404 — no existence leak.",
    tags: ["model"],
    params: idVersionParams,
    response: {
      200: { description: "ModelSpec", ...toJsonSchema(ModelResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const modelDocs: Record<keyof typeof docs, FastifySchema> = docs;
