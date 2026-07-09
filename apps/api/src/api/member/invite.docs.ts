import { EVERDICT_ROLES } from "@everdict/auth";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { AcceptedInviteResponseSchema } from "./response/accepted-invite.js";
import { CreatedInviteResponseSchema } from "./response/created-invite.js";
import { InviteMetaListResponseSchema } from "./response/invite-meta.js";
import { InvitePreviewResponseSchema } from "./response/invite-preview.js";

// OpenAPI descriptors for the invite routes (doc-only — never validates/serializes; see api/openapi.ts).
// An invite is a join secret: issue/list/revoke are admin (members:write); accept needs only an authenticated
// human (OIDC) subject; preview is unauthenticated (the token itself is the secret).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const inviteDocs: Record<"list" | "create" | "revoke" | "accept" | "preview", FastifySchema> = {
  list: {
    summary: "List invites",
    description:
      "Invite metadata for the active workspace — never the token hash or plaintext. Admin only (members:write): an invite is a join secret, so even listing is gated.",
    tags: ["member"],
    response: {
      200: { description: "Invite metadata (no tokens)", ...toJsonSchema(InviteMetaListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  create: {
    summary: "Create an invite",
    description:
      "Admin only (members:write). Returns the invite meta plus the plaintext token — shown exactly once in this response " +
      "(embed it in the join link); only the hash is stored and no other endpoint returns it again.",
    tags: ["member"],
    body: toJsonSchema(
      z.object({
        role: z.enum(EVERDICT_ROLES).describe("Role granted on acceptance"),
        expiresInHours: z.number().int().positive().max(8760).optional().describe("Expiry window; omitted = no expiry"),
      }),
    ),
    response: {
      201: { description: "Invite meta + plaintext token (shown once)", ...toJsonSchema(CreatedInviteResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  revoke: {
    summary: "Revoke an invite",
    description:
      "Admin only (members:write). Workspace-scoped and idempotent — an unknown or foreign id is a no-op 204.",
    tags: ["member"],
    params: toJsonSchema(z.object({ id: z.string().describe("Invite id") })),
    response: {
      204: { description: "Revoked (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
  accept: {
    summary: "Accept an invite",
    description:
      "Redeems the token and joins the workspace — no workspace role gate (this precedes membership) and independent of the active workspace. " +
      "Human (OIDC) subjects only: a machine key is rejected with 400. Already-used = 409, expired = 400, unknown/revoked = 404 (no existence leak).",
    tags: ["member"],
    body: toJsonSchema(z.object({ token: z.string().min(1).describe("Plaintext invite token (inv_…)") })),
    response: {
      200: { description: "Joined — workspace and granted role", ...toJsonSchema(AcceptedInviteResponseSchema) },
      ...errorResponses(400, 401, 404, 409),
    },
  },
  preview: {
    summary: "Preview an invite",
    description:
      "Unauthenticated, non-consuming — the token is the secret. Returns only workspace name/logo/role for the link landing page; " +
      "does not redeem or create a membership. Expired/accepted/revoked/invalid all fold into 404 (no existence leak).",
    tags: ["member"],
    querystring: toJsonSchema(z.object({ token: z.string().describe("Plaintext invite token (required)") })),
    response: {
      200: { description: "Workspace display info + role", ...toJsonSchema(InvitePreviewResponseSchema) },
      ...errorResponses(400, 404),
    },
  },
};
