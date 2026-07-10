import { CommentListResponseSchema } from "@everdict/contracts/wire";
import { CommentResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateCommentBodySchema } from "./request/create-comment.js";

// OpenAPI descriptors for the comment routes (doc-only — never validates/serializes; see api/openapi.ts).
// Resource discussion threads (dataset/harness/scorecard/view/schedule/run/runtime) — read = comments:read
// (viewer+), write = comments:write (member+), delete = author-or-admin (decided in the service).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
export const commentDocs: Record<"list" | "create" | "delete", FastifySchema> = {
  list: {
    summary: "List a resource's comments",
    description:
      "The comment thread for one resource (resourceType + resourceId, both required — 400 when missing). " +
      "Workspace-scoped; requires comments:read (viewer+). Oldest first.",
    tags: ["comment"],
    querystring: toJsonSchema(
      z.object({
        resourceType: z.string().describe("Target resource type (dataset|harness|scorecard|view|schedule|run|runtime)"),
        resourceId: z.string().describe("Target resource id"),
      }),
    ),
    response: {
      200: { description: "Thread (oldest first)", ...toJsonSchema(CommentListResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  create: {
    summary: "Post a comment",
    description:
      "Requires comments:write (member+). With parentId it is a reply — only on a top-level comment of the same resource " +
      "(single-level threads; replying to a reply or a foreign parent is 400). @mentioned subjects get a best-effort notification " +
      "(a notification failure never fails the comment).",
    tags: ["comment"],
    body: toJsonSchema(CreateCommentBodySchema),
    response: {
      201: { description: "Created comment", ...toJsonSchema(CommentResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete a comment",
    description:
      "Author or workspace admin only — the creator-override is decided in the service (the route only authenticates). " +
      "Unknown or foreign id = 404; someone else's comment without admin = 403.",
    tags: ["comment"],
    params: toJsonSchema(z.object({ id: z.string().describe("Comment id") })),
    response: {
      204: { description: "Deleted (no content)" },
      ...errorResponses(401, 403, 404),
    },
  },
};
