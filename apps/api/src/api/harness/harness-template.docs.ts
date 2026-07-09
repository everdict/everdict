import { HarnessTemplateSpecSchema } from "@everdict/core";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { HarnessTemplateListResponseSchema } from "./response/harness-template-list-entry.js";
import { HarnessTemplateVersionsResponseSchema } from "./response/harness-template-versions.js";
import { HarnessTemplateResponseSchema } from "./response/harness-template.js";
import { RegisterHarnessTemplateResultSchema } from "./response/register-harness-template-result.js";
import { ValidateHarnessTemplateResultSchema } from "./response/validate-harness-template-result.js";

// OpenAPI descriptors for the harness-template (category) routes — doc-only (rule api-layer): the no-op
// compilers in server.ts make attaching these behavior-free; validation stays in the handlers.

const idParams = {
  type: "object",
  properties: { id: { type: "string", description: "Template id" } },
  required: ["id"],
};

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Template id" },
    version: { type: "string", description: 'Template version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a harness template version",
    description:
      "Registers a workspace-owned harness template (category: structure/slots, versions unpinned). Requires " +
      "templates:write (viewer+ — collaborative eval content). Versions are immutable — re-registering the same " +
      "(id, version) with different content is 409. Instances are created against this template via POST /harnesses.",
    tags: ["harness"],
    body: toJsonSchema(HarnessTemplateSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterHarnessTemplateResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a harness template spec",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, " +
      "without registering. Requires templates:write (viewer+). Validation failures are reported as ok:false in a " +
      "200 response, not as 4xx.",
    tags: ["harness"],
    body: toJsonSchema(HarnessTemplateSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateHarnessTemplateResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List harness templates",
    description:
      "Lists this workspace's templates plus _shared first-party entries (workspace-owned first, _shared " +
      "fallback). Requires harnesses:read (viewer+).",
    tags: ["harness"],
    response: {
      200: { description: "Template list entries", ...toJsonSchema(HarnessTemplateListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  versions: {
    summary: "Get a template id's versions",
    description:
      "Live versions for one template id (workspace-owned first, _shared fallback). Requires harnesses:read " +
      "(viewer+). An unknown id or another workspace's template reads 404 — no existence leak.",
    tags: ["harness"],
    params: idParams,
    response: {
      200: { description: "Versions", ...toJsonSchema(HarnessTemplateVersionsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a harness template version",
    description:
      "The template (category) structure spec for one version — for the detail-view config panel and new-version " +
      'edit prefill. version may be "latest". Requires harnesses:read (viewer+). Missing id/version reads 404.',
    tags: ["harness"],
    params: idVersionParams,
    response: {
      200: { description: "HarnessTemplateSpec", ...toJsonSchema(HarnessTemplateResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const harnessTemplateDocs: Record<keyof typeof docs, FastifySchema> = docs;
