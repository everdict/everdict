import { COMMENT_RESOURCE_TYPES } from "@everdict/application-control";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain, run } from "../mcp-context.js";

export function registerCommentTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.commentService) {
    const comments = deps.commentService;
    // Resource comments — read=comments:read, write=comments:write, delete=author-or-admin (decided by the service). BFF parity: GET/POST/DELETE /comments.
    server.registerTool(
      "list_comments",
      {
        description: "Comments on a resource (dataset, etc.) — oldest→newest (timeline order).",
        inputSchema: {
          resource_type: z.enum(COMMENT_RESOURCE_TYPES),
          resource_id: z.string(),
        },
      },
      ({ resource_type, resource_id }) =>
        run(principal, "comments:read", async () =>
          ok({ comments: await comments.list(ws, resource_type, resource_id) }),
        ),
    );
    server.registerTool(
      "create_comment",
      {
        description:
          "Post a comment on a resource. Author = me (subject). Reply via parent_id; @-mentioning member subjects via mentions notifies them.",
        inputSchema: {
          resource_type: z.enum(COMMENT_RESOURCE_TYPES),
          resource_id: z.string(),
          parent_id: z.string().optional().describe("parent comment id if this is a reply (single-level thread)"),
          body: z.string().min(1),
          mentions: z.array(z.string()).optional().describe("member subjects to @-mention (notification targets)"),
        },
      },
      ({ resource_type, resource_id, parent_id, body, mentions }) =>
        run(principal, "comments:write", async () =>
          ok(
            await comments.create({
              tenant: ws,
              resourceType: resource_type,
              resourceId: resource_id,
              author: principal.subject,
              body,
              ...(parent_id ? { parentId: parent_id } : {}),
              ...(mentions ? { mentions } : {}),
            }),
          ),
        ),
    );
    server.registerTool(
      "delete_comment",
      {
        description: "Delete a comment — author or workspace admin only.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await comments.delete({
            tenant: ws,
            id,
            subject: principal.subject,
            isAdmin: principal.roles.includes("admin"),
          });
          return ok({ id, deleted: true });
        }),
    );
  }
}
