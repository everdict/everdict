import { VersionTagsBodySchema } from "@everdict/application-control";
import { JudgeSpecSchema } from "@everdict/contracts";
import { JudgeListResponseSchema } from "@everdict/contracts/wire";
import { JudgeResponseSchema } from "@everdict/contracts/wire";
import { RegisterJudgeResultSchema } from "@everdict/contracts/wire";
import { ValidateJudgeResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetVersionTagsResultSchema } from "./response/set-version-tags-result.js";

// OpenAPI descriptors for the judge routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Judge id" },
    version: { type: "string", description: 'Judge version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register an Agent Judge version",
    description:
      "Registers a workspace-owned Agent Judge (kind model = LLM/VLM call, kind harness = delegate to a " +
      "harness). Requires judges:write (member+). Versions are immutable — re-registering the same (id, version) " +
      "with different content is 409. Reads resolve workspace-owned first with a _shared (first-party) fallback.",
    tags: ["judge"],
    body: toJsonSchema(JudgeSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterJudgeResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a judge spec",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, " +
      "without registering. Requires judges:write (member+). Validation failures are reported as ok:false in a " +
      "200 response, not as 4xx.",
    tags: ["judge"],
    body: toJsonSchema(JudgeSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateJudgeResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List judges",
    description:
      "Lists this workspace's judges plus _shared first-party entries (workspace-owned first, _shared fallback). " +
      "Requires judges:read (viewer+).",
    tags: ["judge"],
    response: {
      200: { description: "Judge list entries", ...toJsonSchema(JudgeListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a judge version",
    description:
      'The full JudgeSpec for one version. version may be "latest" (semver-latest). Requires judges:read ' +
      "(viewer+). Another workspace's judge reads 404 — no existence leak.",
    tags: ["judge"],
    params: idVersionParams,
    response: {
      200: { description: "JudgeSpec", ...toJsonSchema(JudgeResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a judge version's tags",
    description:
      "Whole-array PUT of free-form version labels (empty array = clear) — mutable registry metadata outside the " +
      "immutable spec. Requires judges:write (member+). Targets tenant-owned versions only — _shared or another " +
      "workspace's versions are 404.",
    tags: ["judge"],
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
export const judgeDocs: Record<keyof typeof docs, FastifySchema> = docs;
