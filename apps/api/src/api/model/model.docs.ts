import { ModelSpecSchema } from "@everdict/contracts";
import { DeleteModelVersionResultSchema } from "@everdict/contracts/wire";
import { DeleteModelVersionsResultSchema } from "@everdict/contracts/wire";
import { ModelListResponseSchema } from "@everdict/contracts/wire";
import { ModelResponseSchema } from "@everdict/contracts/wire";
import { RegisterModelResultSchema } from "@everdict/contracts/wire";
import { SaveModelResultSchema } from "@everdict/contracts/wire";
import { TestModelConnectionResultSchema } from "@everdict/contracts/wire";
import { ValidateModelResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { DeleteModelVersionsBodySchema } from "./request/delete-model-versions.js";
import { SaveModelBodySchema } from "./request/save-model.js";
import { TestModelConnectionBodySchema } from "./request/test-connection.js";

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
  testConnection: {
    summary: "Test a model connection (dummy completion)",
    description:
      "Resolves the connection's apiKeySecret from the workspace/personal secret tiers and fires ONE minimal dummy " +
      "completion to prove the model is reachable and responding. Requires models:write (member+ — it makes a real " +
      "billable call). The probe outcome (ok:true + response text preview | ok:false + reason) is returned as a 200; " +
      "a missing key / upstream error / network failure is ok:false, not a 4xx.",
    tags: ["model"],
    body: toJsonSchema(TestModelConnectionBodySchema),
    response: {
      200: { description: "Probe outcome", ...toJsonSchema(TestModelConnectionResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  save: {
    summary: "Save (upsert) a model connection",
    description:
      "The interactive edit path: a new id registers version 1.0.0; a changed connection auto patch-bumps to a NEW " +
      "immutable version (so `latest` moves while past-pinned scorecards stay reproducible); an unchanged connection " +
      "is an idempotent no-op (created:false). The id is the path param and the version is assigned server-side, so " +
      "neither is in the body. Requires models:write (member+). POST /models remains the explicit-version programmatic path.",
    tags: ["model"],
    params: { type: "object", properties: { id: { type: "string", description: "Model id" } }, required: ["id"] },
    body: toJsonSchema(SaveModelBodySchema),
    response: {
      200: { description: "Saved (created:true) or unchanged (created:false)", ...toJsonSchema(SaveModelResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
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
  deleteVersion: {
    summary: "Soft-delete a model version",
    description:
      "Tombstones one model version (data preserved, excluded from reads → past scorecards that referenced it stay " +
      "reproducible). Allowed for that version's creator or a workspace admin (models:delete) — enforced in the " +
      "service. Missing/already-deleted/non-owned versions are 404.",
    tags: ["model"],
    params: idVersionParams,
    response: {
      200: { description: "Deleted (tombstoned)", ...toJsonSchema(DeleteModelVersionResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  deleteVersions: {
    summary: "Soft-delete several model versions or the whole model",
    description:
      "Bulk tombstone — pass `versions` to delete specific versions, or omit the body to delete the whole model " +
      "(all of its own live versions). Every target is checked creator-or-admin (models:delete) BEFORE any delete, " +
      "so a single forbidden/absent version rejects the whole request (403/404) with nothing deleted. Data is " +
      "preserved (past scorecards stay reproducible). An unknown / already-fully-deleted model is 404.",
    tags: ["model"],
    params: { type: "object", properties: { id: { type: "string", description: "Model id" } }, required: ["id"] },
    body: toJsonSchema(DeleteModelVersionsBodySchema),
    response: {
      200: { description: "Deleted (tombstoned) versions", ...toJsonSchema(DeleteModelVersionsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const modelDocs: Record<keyof typeof docs, FastifySchema> = docs;
