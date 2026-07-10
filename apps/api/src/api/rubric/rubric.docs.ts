import { VersionTagsBodySchema } from "@everdict/application-control";
import { RegisterRubricResultSchema } from "@everdict/contracts/wire";
import { RubricListResponseSchema } from "@everdict/contracts/wire";
import { RubricResponseSchema } from "@everdict/contracts/wire";
import { ValidateRubricResultSchema } from "@everdict/contracts/wire";
import { RubricSpecSchema } from "@everdict/core";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetVersionTagsResultSchema } from "./response/set-version-tags-result.js";

// OpenAPI descriptors for the rubric routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Rubric id" },
    version: { type: "string", description: 'Rubric version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a rubric version",
    description:
      "Registers a workspace-owned rubric (HOW to judge: freeform text and/or named criteria plus an optional " +
      "prompt template — referenced by judges as rubric:{id, version}). Requires judges:write (member+, " +
      "judging-domain action reused). Versions are immutable — re-registering the same (id, version) with " +
      "different content is 409. Reads resolve workspace-owned first with a _shared (first-party) fallback.",
    tags: ["rubric"],
    body: toJsonSchema(RubricSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterRubricResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a rubric spec",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, " +
      "without registering. Requires judges:write (member+). Validation failures are reported as ok:false in a " +
      "200 response, not as 4xx.",
    tags: ["rubric"],
    body: toJsonSchema(RubricSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateRubricResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List rubrics",
    description:
      "Lists this workspace's rubrics plus _shared first-party entries (workspace-owned first, _shared fallback). " +
      "Requires judges:read (viewer+).",
    tags: ["rubric"],
    response: {
      200: { description: "Rubric list entries", ...toJsonSchema(RubricListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a rubric version",
    description:
      'The full RubricSpec for one version. version may be "latest" (semver-latest). Requires judges:read ' +
      "(viewer+). Another workspace's rubric reads 404 — no existence leak.",
    tags: ["rubric"],
    params: idVersionParams,
    response: {
      200: { description: "RubricSpec", ...toJsonSchema(RubricResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a rubric version's tags",
    description:
      "Whole-array PUT of free-form version labels (empty array = clear) — mutable registry metadata outside the " +
      "immutable spec. Requires judges:write (member+). Targets tenant-owned versions only — _shared or another " +
      "workspace's versions are 404.",
    tags: ["rubric"],
    params: idVersionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: { description: "Normalized tags after replacement", ...toJsonSchema(SetVersionTagsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const rubricDocs: Record<keyof typeof docs, FastifySchema> = docs;
