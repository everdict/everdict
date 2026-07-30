import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// The owned trajectory ledger over MCP — BFF↔MCP parity with trajectory.routes.ts. Browse the sealed
// evidence (metas), then open one with get_run_trajectory (the run is the home).
export function registerTrajectoryTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.trajectoryStore) return;
  const store = deps.trajectoryStore;

  server.registerTool(
    "list_trajectories",
    {
      description:
        "List the workspace's SEALED trajectories (the owned evidence ledger, newest first, cursor-paginated). " +
        "Each meta says how the evidence arrived (source: run | otlp | import) and how big it is (eventCount). " +
        "Open one with get_run_trajectory.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().optional().describe("opaque cursor from the previous page"),
      },
    },
    ({ limit, cursor }: { limit?: number; cursor?: string }) =>
      run(principal, "runs:read", async () =>
        ok(
          await store.list(ws, {
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
          }),
        ),
      ),
  );
}
