import { WorkspaceSettingsViewSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { WorkspaceSettingsBodySchema } from "./request/workspace-settings.js";

// OpenAPI descriptors for the workspace-settings routes (doc-only — never validates/serializes; see api/openapi.ts).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const settingsDocs: Record<"get" | "put", FastifySchema> = {
  get: {
    summary: "Get workspace settings",
    description:
      "The workspace's control-plane policy record (metering, default judge, integrations, image registries, trace sinks, CI links). " +
      "Requires settings:read (admin). Returns {} when nothing has been set. Secret fields are SecretStore name-refs — values are never returned.",
    tags: ["workspace"],
    response: {
      200: {
        description: "Workspace settings (empty object when unset)",
        ...toJsonSchema(WorkspaceSettingsViewSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  put: {
    summary: "Patch workspace settings",
    description:
      "Partial-merge upsert (settings:write, admin): metering on/off, default judge model, completion-notification target. " +
      "The notify target's ownerSubject is stamped server-side from the caller (anti-spoofing). Returns the merged settings.",
    tags: ["workspace"],
    body: toJsonSchema(WorkspaceSettingsBodySchema),
    response: {
      200: { description: "Merged workspace settings", ...toJsonSchema(WorkspaceSettingsViewSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
};
