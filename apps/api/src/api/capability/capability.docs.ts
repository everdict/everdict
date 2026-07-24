import { CapabilityRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SaveCapabilityBodySchema } from "./request/save-capability.js";
import { SetCapabilityVisibilityBodySchema } from "./request/set-capability-visibility.js";

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
      "version; publishing a brand-new capability as 'public' requires an admin. Requires capabilities:write (member+).",
    tags: ["capability"],
    params: idParams,
    body: toJsonSchema(SaveCapabilityBodySchema),
    response: {
      200: { description: "Saved (version assigned)", ...toJsonSchema(SaveResultSchema) },
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
      "The latest live version of a capability in my workspace. A private one is visible only to its creator; " +
      "workspace/subset/public to any member (otherwise 404). Requires capabilities:read.",
    tags: ["capability"],
    params: idParams,
    response: {
      200: { description: "Capability", ...toJsonSchema(CapabilityRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  getVersion: {
    summary: "Get an exact capability version",
    description:
      "A specific immutable version of a capability in my workspace (visibility-checked, else 404). Requires capabilities:read.",
    tags: ["capability"],
    params: versionParams,
    response: {
      200: { description: "Capability version", ...toJsonSchema(CapabilityRecordSchema) },
      ...errorResponses(401, 403, 404),
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
