import { WorkspaceRecordResponseSchema } from "@everdict/contracts/wire";
import { WorkspaceWithRoleListResponseSchema, WorkspaceWithRoleResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptors for the workspace routes (doc-only — never validates/serializes; see api/openapi.ts).
// Plural /workspaces = self-serve membership (my list + create); singular /workspace = the active workspace's record.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const workspaceDocs: Record<"list" | "create" | "get" | "update" | "delete", FastifySchema> = {
  list: {
    summary: "List my workspaces",
    description:
      "Workspaces the authenticated subject is a member of, each with that subject's role. Self-scoped — no workspace role gate.",
    tags: ["workspace"],
    response: {
      200: { description: "My workspaces (with role)", ...toJsonSchema(WorkspaceWithRoleListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  create: {
    summary: "Create a workspace",
    description:
      "Self-serve — open to any authenticated subject (no in-workspace role gate); the creator becomes the workspace admin. " +
      "id (slug) is optional: an explicit id collision is 409, while a slug derived from the name is made unique with a random suffix.",
    tags: ["workspace"],
    body: toJsonSchema(
      z.object({
        name: z.string().min(1).describe("Display name (required)"),
        id: z.string().optional().describe("Explicit slug (^[a-z0-9][a-z0-9-]*$); omitted = derived from name"),
      }),
    ),
    response: {
      201: {
        description: 'Created workspace — role is always "admin" (the creator)',
        ...toJsonSchema(WorkspaceWithRoleResponseSchema),
      },
      ...errorResponses(400, 401, 404, 409),
    },
  },
  get: {
    summary: "Get the active workspace record",
    description:
      "The active workspace's metadata (id/name/owner/logo/createdAt). Requires settings:read. The workspace is taken from the principal — never from the client.",
    tags: ["workspace"],
    response: {
      200: { description: "Workspace record", ...toJsonSchema(WorkspaceRecordResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Update workspace display info",
    description:
      "Patch name and/or logo (settings:write). The slug (id) is immutable. An empty-string logoUrl removes the logo.",
    tags: ["workspace"],
    body: toJsonSchema(
      z.object({
        name: z.string().optional().describe("New display name (max 80 chars)"),
        logoUrl: z.string().optional().describe("http(s) URL or data:image base64; empty string removes the logo"),
      }),
    ),
    response: {
      200: { description: "Updated workspace record", ...toJsonSchema(WorkspaceRecordResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete the active workspace",
    description:
      "Hard-deletes the workspace and ALL its scoped data (cascade). Owner (creator) only — an ownership gate, not the role matrix; a non-owner admin gets 403.",
    tags: ["workspace"],
    response: {
      204: { description: "Deleted (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
};
