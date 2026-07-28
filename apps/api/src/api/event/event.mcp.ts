import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of GET /events (BFF↔MCP parity) — the workspace's recorded lifecycle facts, newest first.
export function registerEventTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.platformEvents) return;
  const platformEvents = deps.platformEvents;

  server.registerTool(
    "list_platform_events",
    {
      description:
        "The workspace's recorded platform events (lifecycle facts: run/scorecard/comment/agent-run), newest " +
        "first — the same log that wakes trigger agents. Use it to inspect what happened or to pick a real event " +
        "to replay at a draft agent.",
      inputSchema: {
        after: z.number().int().nonnegative().optional().describe("only events with seq > after"),
        kinds: z.array(z.string()).optional().describe("restrict to these kinds"),
        limit: z.number().int().positive().max(200).optional().describe("default 50"),
      },
    },
    ({ after, kinds, limit }) =>
      run(principal, "events:read", async () =>
        ok({
          events: await platformEvents.list(ws, {
            ...(after !== undefined ? { afterSeq: after } : {}),
            ...(kinds !== undefined ? { kinds } : {}),
            limit: limit ?? 50,
            order: "desc",
          }),
        }),
      ),
  );
}
