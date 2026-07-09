import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Queue resource MCP tools — the MCP twin of queue.routes.ts (same QueueService core, second transport).
export function registerQueueTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.queueService) {
    const queue = deps.queueService;
    server.registerTool(
      "get_queue",
      {
        description:
          "Work queue snapshot — per runtime lane: running/waiting (FIFO, the front is the next job)/next scheduled fire. A batch (scorecard) = 1 job (with progress).",
        inputSchema: {},
      },
      () => run(principal, "runs:read", async () => ok(await queue.snapshot(ws, principal.subject))),
    );
  }
}
