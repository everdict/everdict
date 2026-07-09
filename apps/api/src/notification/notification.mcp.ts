import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

export function registerNotificationTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.notificationService) {
    const notifications = deps.notificationService;
    // The notification feed is personally owned (recipient=principal.subject) — no role gate (self-scoped, plain). BFF parity: GET/POST /notifications.
    server.registerTool(
      "list_notifications",
      {
        description: "My notification feed (job completions, etc.) — newest first. unread=true for unread only.",
        inputSchema: {
          unread: z.boolean().optional().describe("if true, unread only"),
          limit: z.number().int().positive().max(200).optional(),
        },
      },
      ({ unread, limit }) =>
        plain(async () =>
          ok({
            notifications: await notifications.listFeed(principal.subject, ws, {
              ...(unread === true ? { unreadOnly: true } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          }),
        ),
    );
    server.registerTool(
      "read_notifications",
      {
        description: "Mark notifications read — give ids or all=true. Returns the count processed (idempotent).",
        inputSchema: {
          ids: z.array(z.string()).optional(),
          all: z.boolean().optional(),
        },
      },
      ({ ids, all }) =>
        plain(async () =>
          ok({ read: await notifications.markFeedRead(principal.subject, ws, all === true ? "all" : (ids ?? [])) }),
        ),
    );
  }
}
