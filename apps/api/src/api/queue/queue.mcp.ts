import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Queue resource MCP tools — the MCP twin of queue.routes.ts (same QueueService core, second transport).
export function registerQueueTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.queueService) {
    const queue = deps.queueService;
    server.registerTool(
      "get_queue",
      {
        annotations: { readOnlyHint: true },
        description:
          "Work queue snapshot — per runtime lane: running/waiting (FIFO, the front is the next job)/next scheduled fire. A batch (scorecard) = 1 job (with progress). scheduler.entries is this workspace's REAL control-plane scheduler queue in effective scan order (position 1 is next).",
        inputSchema: {},
      },
      () => run(principal, "runs:read", async () => ok(await queue.snapshot(ws, principal.subject))),
    );
    server.registerTool(
      "cancel_queued_job",
      {
        annotations: { readOnlyHint: false },
        description:
          "Cancel ONE waiting control-plane scheduler entry (a scheduler.entries id from get_queue) — settles its dispatch as CANCELLED. In-flight work is untouched.",
        inputSchema: { entryId: z.string().describe("The scheduler.entries id") },
      },
      ({ entryId }) => run(principal, "runs:submit", async () => ok(queue.cancelSchedulerEntry(ws, entryId))),
    );
    server.registerTool(
      "promote_queued_job",
      {
        annotations: { readOnlyHint: false },
        description:
          "Move ONE waiting control-plane scheduler entry (a scheduler.entries id from get_queue) to the front of the effective order — 'run this next'.",
        inputSchema: { entryId: z.string().describe("The scheduler.entries id") },
      },
      ({ entryId }) => run(principal, "runs:submit", async () => ok(queue.promoteSchedulerEntry(ws, entryId))),
    );
  }
}
