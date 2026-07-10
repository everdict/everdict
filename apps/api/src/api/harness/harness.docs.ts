import { VersionTagsBodySchema } from "@everdict/application-control";
import { RepinBodySchema } from "@everdict/application-control";
import { HarnessInstanceSpecSchema } from "@everdict/contracts";
import { DeleteHarnessVersionResultSchema } from "@everdict/contracts/wire";
import { HarnessInstanceResponseSchema } from "@everdict/contracts/wire";
import { HarnessListResponseSchema } from "@everdict/contracts/wire";
import { HarnessVersionsResponseSchema } from "@everdict/contracts/wire";
import { RegisterHarnessResultSchema } from "@everdict/contracts/wire";
import { RepinResultSchema } from "@everdict/contracts/wire";
import { ResolvedHarnessResponseSchema } from "@everdict/contracts/wire";
import { ValidateHarnessResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetVersionTagsResultSchema } from "./response/set-version-tags-result.js";

// OpenAPI descriptors for the harness (instance) routes — doc-only (rule api-layer): the no-op compilers in
// server.ts make attaching these behavior-free; validation stays in the handlers.

const idParams = {
  type: "object",
  properties: { id: { type: "string", description: "Harness id" } },
  required: ["id"],
};

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Harness id" },
    version: { type: "string", description: 'Instance version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a harness instance version",
    description:
      "Registers a workspace-owned harness instance (template reference + pins). Requires harnesses:register " +
      "(viewer+ — collaborative eval content). The spec is confirmed via resolve: a missing template is 404, a " +
      "missing/unknown pin is 400. Versions are immutable — re-registering the same (id, version) with different " +
      "content is 409. The response surfaces write-time advisories: image-classification warnings " +
      "(local/unqualified images, warn-not-block) and private:true when the spec references a personal secret " +
      "(the harness becomes visible to the creator only).",
    tags: ["harness"],
    body: toJsonSchema(HarnessInstanceSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterHarnessResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a harness instance spec",
    description:
      "Validates schema + template existence + pin resolution without registering (pre-check for the register " +
      "flow). Requires harnesses:register (viewer+). Validation failures are reported as ok:false in a 200 " +
      "response, not as 4xx; image warnings are included on success.",
    tags: ["harness"],
    body: toJsonSchema(HarnessInstanceSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateHarnessResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List harnesses",
    description:
      "Lists this workspace's harnesses (instances grouped by template id) plus _shared first-party entries. " +
      "Requires harnesses:read (viewer+). Private harnesses (referencing a personal secret) are filtered to " +
      "their owner — other members do not see them at all.",
    tags: ["harness"],
    response: {
      200: { description: "Harness list entries", ...toJsonSchema(HarnessListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  versions: {
    summary: "Get a harness id's versions",
    description:
      "Live versions + version tags for one harness id (workspace-owned first, _shared fallback). Requires " +
      "harnesses:read (viewer+). Another workspace's or a private (non-owned) harness reads 404 — no existence leak.",
    tags: ["harness"],
    params: idParams,
    response: {
      200: { description: "Versions + tags", ...toJsonSchema(HarnessVersionsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  resolved: {
    summary: "Get the resolved harness spec",
    description:
      'Resolves the instance (template + pins) into a full HarnessSpec — for the web pin diff/preview. version may be "latest". ' +
      "Requires harnesses:read (viewer+). Missing id/version, another workspace's, or a private (non-owned) harness reads 404.",
    tags: ["harness"],
    params: idVersionParams,
    response: {
      200: { description: "Resolved HarnessSpec", ...toJsonSchema(ResolvedHarnessResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  instance: {
    summary: "Get the raw harness instance",
    description:
      "The original instance (template reference + pins) before resolve — for the detail-view config panel and " +
      'new-version re-pin prefill. version may be "latest". Requires harnesses:read (viewer+); same private/owner ' +
      "404 semantics as the resolved read.",
    tags: ["harness"],
    params: idVersionParams,
    response: {
      200: { description: "Raw HarnessInstanceSpec", ...toJsonSchema(HarnessInstanceResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  deleteVersion: {
    summary: "Soft-delete a harness version",
    description:
      "Tombstones one instance version — data preserved (past scorecards keep their harness snapshot), excluded " +
      "from all reads; future runs referencing it fail to resolve. Allowed for that version's creator or a " +
      "workspace admin (harnesses:delete) — enforced in the service. Missing/already-deleted/non-owned versions are 404.",
    tags: ["harness"],
    params: idVersionParams,
    response: {
      200: { description: "Deleted (tombstoned)", ...toJsonSchema(DeleteHarnessVersionResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a harness version's tags",
    description:
      "Whole-array PUT of free-form version labels (empty array = clear) — mutable registry metadata outside the " +
      "immutable spec. Requires harnesses:register (viewer+, same gate as register). Targets tenant-owned live " +
      "versions only — _shared or another workspace's versions are 404.",
    tags: ["harness"],
    params: idVersionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: { description: "Normalized tags after replacement", ...toJsonSchema(SetVersionTagsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  repin: {
    summary: "Re-pin harness images (register a new version)",
    description:
      "Durable headless re-pin: merges the requested slot → image pins over the base instance's pins and registers " +
      'a new immutable instance version (the CI merge path; same meaning as the web "Create new version"). Requires ' +
      "harnesses:register (viewer+; the ci role has it). Digest pins (@sha256:…) are enforced unless allowTags:true. " +
      "Idempotent: identical pins return 200 unchanged; a new version returns 201. Missing base is 404, a tag pin or " +
      "unknown slot is 400, a version collision is 409.",
    tags: ["harness"],
    params: idParams,
    body: toJsonSchema(RepinBodySchema),
    response: {
      200: { description: "Unchanged (merge equals the base; no registration)", ...toJsonSchema(RepinResultSchema) },
      201: { description: "New instance version registered", ...toJsonSchema(RepinResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const harnessDocs: Record<keyof typeof docs, FastifySchema> = docs;
