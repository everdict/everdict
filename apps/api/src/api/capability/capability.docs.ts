import { VersionTagsBodySchema } from "@everdict/application-control";
import { CapabilityRecordSchema, CapabilitySpecDiffSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { ProbeCapabilityMcpBodySchema } from "./request/probe-capability-mcp.js";
import { SaveCapabilityBodySchema } from "./request/save-capability.js";
import { SetCapabilityVisibilityBodySchema } from "./request/set-capability-visibility.js";
import { ValidateCapabilityBodySchema } from "./request/validate-capability.js";
import { CapabilityVersionsResponseSchema } from "./response/capability-versions.js";
import { ProbeCapabilityMcpResultSchema } from "./response/probe-capability-mcp-result.js";
import { ValidateCapabilityResultSchema } from "./response/validate-capability-result.js";

// The optional `source` querystring on the version reads — the OWNER workspace of a cross-tenant public/subset
// capability (defaults to the caller's own workspace when omitted).
const sourceQuery = {
  type: "object",
  properties: {
    source: { type: "string", description: "Owner workspace for a cross-tenant public/subset capability" },
  },
};

// OpenAPI descriptors for the capability routes — doc-only (rule api-layer): attaching these is behavior-free.

const idParams = {
  type: "object",
  properties: { id: { type: "string", description: "Capability id" } },
  required: ["id"],
};
const versionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Capability id" },
    version: { type: "string", description: "Exact immutable version" },
  },
  required: ["id", "version"],
};

const SaveResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
});

const docs = {
  save: {
    summary: "Author (create or edit) a capability",
    description:
      "Version-free upsert of a Store capability (mcp | code | skill). A new id creates version 1.0.0; a content " +
      "change on an existing id patch-bumps to a new immutable version (so `latest` moves while pinned adoptions stay " +
      "reproducible); an unchanged spec is a no-op. Only the capability's owner or a workspace admin may publish a new " +
      "version; publishing a brand-new capability as 'public' requires an admin. Omitting `visibility` on the first " +
      "version defaults by kind: an `environment` (the image a harness pins, used workspace-wide) becomes 'workspace', " +
      "a tool kind stays 'private'. Requires capabilities:write (member+).",
    tags: ["capability"],
    params: idParams,
    body: toJsonSchema(SaveCapabilityBodySchema),
    response: {
      200: { description: "Saved (version assigned)", ...toJsonSchema(SaveResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  validate: {
    summary: "Validate a capability (dry-run of a save)",
    description:
      "Parse the discriminated spec and predict what a save would do WITHOUT writing: whether it creates a new " +
      "capability or a new version (and which version), the existing live versions, and — for an environment kind — " +
      "image pull-readiness warnings. Bad spec → { ok:false, errors }. Requires capabilities:write (member+).",
    tags: ["capability"],
    body: toJsonSchema(ValidateCapabilityBodySchema),
    response: {
      200: { description: "Validation result", ...toJsonSchema(ValidateCapabilityResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  probeMcp: {
    summary: "Probe an mcp capability URL (test connection + tool discovery)",
    description:
      "Connect to a candidate MCP server (Streamable HTTP) and list its tools, so the wizard can verify reachability " +
      "and prefill `provides`. A failure is a result (reachable:false + reason), never an error. `token` is a transient " +
      "bearer for the test only (never stored). Requires capabilities:write (member+).",
    tags: ["capability"],
    body: toJsonSchema(ProbeCapabilityMcpBodySchema),
    response: {
      200: { description: "Probe result", ...toJsonSchema(ProbeCapabilityMcpResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List capabilities visible to my workspace",
    description:
      "Browse 'my store' — every capability this workspace can use WITHOUT the global public catalog: own private " +
      "(mine) + own workspace + own subset + subset shared to this workspace. Latest live version per capability. " +
      "Requires capabilities:read (viewer+).",
    tags: ["capability"],
    response: {
      200: { description: "Visible capabilities", ...toJsonSchema(z.array(CapabilityRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  listPublic: {
    summary: "Browse the public capability catalog",
    description:
      "Every capability published 'public' across all workspaces (latest live version per capability). Requires capabilities:read.",
    tags: ["capability"],
    response: {
      200: { description: "Public capabilities", ...toJsonSchema(z.array(CapabilityRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a capability (latest version)",
    description:
      "The latest live version of a capability. A private one is visible only to its creator; workspace/subset/public " +
      "to any member (otherwise 404). By default my workspace; `source` reads a cross-tenant public/subset owner. " +
      "Requires capabilities:read.",
    tags: ["capability"],
    params: idParams,
    querystring: sourceQuery,
    response: {
      200: { description: "Capability", ...toJsonSchema(CapabilityRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  getVersion: {
    summary: "Get an exact capability version",
    description:
      "A specific immutable version of a capability (visibility-checked, else 404). By default my workspace; `source` " +
      "reads a cross-tenant public/subset owner (so the store switcher can inspect an older public version). Requires capabilities:read.",
    tags: ["capability"],
    params: versionParams,
    querystring: sourceQuery,
    response: {
      200: { description: "Capability version", ...toJsonSchema(CapabilityRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  versions: {
    summary: "List a capability's versions",
    description:
      "The live versions (ascending) of a capability the caller can see + a version→tags display map (only tagged " +
      "versions). By default my workspace; `source` reads a cross-tenant public/subset owner. A not-visible / missing " +
      "capability is 404 (no existence leak). Requires capabilities:read (viewer+).",
    tags: ["capability"],
    params: idParams,
    querystring: sourceQuery,
    response: {
      200: { description: "Versions + version tags", ...toJsonSchema(CapabilityVersionsResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  diff: {
    summary: "Diff two capability versions",
    description:
      "Structural diff between base and candidate versions of the same capability, over the immutable content " +
      '(name/description/spec). Reports leaf field changes by path; typeChanged flags a kind restructure. Both refs may be "latest". ' +
      "By default my workspace; `source` diffs a cross-tenant public/subset owner. Missing base/candidate is 400; an " +
      "unknown version or a not-visible capability is 404. Requires capabilities:read (viewer+).",
    tags: ["capability"],
    params: idParams,
    querystring: {
      type: "object",
      properties: {
        base: { type: "string", description: 'Base version ref (accepts "latest")' },
        candidate: { type: "string", description: 'Candidate version ref (accepts "latest")' },
        source: { type: "string", description: "Owner workspace for a cross-tenant public/subset capability" },
      },
      required: ["base", "candidate"],
    },
    response: {
      200: { description: "Structural spec diff (base ↔ candidate)", ...toJsonSchema(CapabilitySpecDiffSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a capability version's tags",
    description:
      "Replace the full tag set of a single version (empty array = remove all) — free-form labels to tell versions " +
      "apart, outside spec immutability (each ≤60 chars, ≤20 per version; replace semantics). Only the version's " +
      "creator or a workspace admin. Requires capabilities:write (member+).",
    tags: ["capability"],
    params: versionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: {
        description: "Updated version tags",
        ...toJsonSchema(
          z.object({ workspace: z.string(), id: z.string(), version: z.string(), tags: z.array(z.string()) }),
        ),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setVisibility: {
    summary: "Change a capability's reach",
    description:
      "Set the reach across every live version: private | workspace | subset (with sharedWith target workspace ids) " +
      "| public. Owner-or-admin; promoting to 'public' additionally requires a workspace admin. Requires capabilities:write.",
    tags: ["capability"],
    params: idParams,
    body: toJsonSchema(SetCapabilityVisibilityBodySchema),
    response: {
      200: { description: "Updated capability", ...toJsonSchema(CapabilityRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  deleteVersion: {
    summary: "Delete a capability version",
    description:
      "Soft-delete a single version (tombstone; content preserved, excluded from reads). Only the version's creator " +
      "or a workspace admin. Requires capabilities:write.",
    tags: ["capability"],
    params: versionParams,
    response: { 204: { description: "Deleted" }, ...errorResponses(401, 403, 404) },
  },
} satisfies Record<string, FastifySchema>;

export const capabilityDocs: Record<keyof typeof docs, FastifySchema> = docs;
