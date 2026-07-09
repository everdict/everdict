import { EVERDICT_ROLES } from "@everdict/auth";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { MemberListResponseSchema } from "./response/member.js";

// OpenAPI descriptors for the member routes (doc-only — never validates/serializes; see api/openapi.ts).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const memberDocs: Record<"list" | "setRole" | "leave" | "remove", FastifySchema> = {
  list: {
    summary: "List workspace members",
    description:
      "Members of the active workspace with role, join time, and profile-enriched name/avatar. Requires members:read (viewer+).",
    tags: ["member"],
    response: {
      200: { description: "Workspace members (join-time ascending)", ...toJsonSchema(MemberListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  setRole: {
    summary: "Change a member's role",
    description:
      "Admin only (members:write). 404 if the subject is not a member. Demoting the last admin is rejected with 409 — delegate admin first.",
    tags: ["member"],
    params: toJsonSchema(z.object({ subject: z.string().describe("The member's subject (identity key)") })),
    body: toJsonSchema(z.object({ role: z.enum(EVERDICT_ROLES).describe("New membership role") })),
    response: {
      204: { description: "Role changed (no content)" },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  leave: {
    summary: "Leave the active workspace",
    description:
      "Self-serve — removes only the caller's own membership, no role gate. Idempotent (leaving a workspace you are not in is a no-op). " +
      "The last admin cannot leave (409): delegate admin to another member or delete the workspace instead.",
    tags: ["member"],
    response: {
      204: { description: "Left the workspace (no content)" },
      ...errorResponses(401, 404, 409),
    },
  },
  remove: {
    summary: "Remove a member",
    description:
      "Admin only (members:write). Idempotent — removing a non-member is a no-op 204 (no existence leak). " +
      "Removing the last admin is rejected with 409.",
    tags: ["member"],
    params: toJsonSchema(z.object({ subject: z.string().describe("The member's subject (identity key)") })),
    response: {
      204: { description: "Removed (no content; also returned when the subject was not a member)" },
      ...errorResponses(401, 403, 404, 409),
    },
  },
};
