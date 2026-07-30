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

  // Trace thresholds (E4 perception config) — BFF↔MCP parity with the /workspace/trace-thresholds routes.
  const settings = deps.settingsStore;
  if (!settings) return;

  server.registerTool(
    "get_workspace_trace_thresholds",
    {
      description:
        "The tenant-configured trace thresholds — evaluated over EVERY trajectory at seal time; a crossing " +
        "lands trace.threshold_crossed on the event log (the wake signal a triage agent subscribes to).",
      inputSchema: {},
    },
    () => run(principal, "runs:read", async () => ok({ thresholds: (await settings.get(ws))?.traceThresholds ?? [] })),
  );

  server.registerTool(
    "set_workspace_trace_thresholds",
    {
      description:
        "Replace the workspace's trace thresholds (full replacement). metric: usd | total_tokens | llm_calls | " +
        "tool_calls | tool_failures | events | latency_ms_max; value is the exceeds-bound (strictly greater). " +
        "Applies to the next sealed trajectory. Admin (settings:write).",
      inputSchema: {
        thresholds: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              metric: z.enum([
                "usd",
                "total_tokens",
                "llm_calls",
                "tool_calls",
                "tool_failures",
                "events",
                "latency_ms_max",
              ]),
              value: z.number().nonnegative(),
            }),
          )
          .max(50),
      },
    },
    ({
      thresholds,
    }: {
      thresholds: Array<{
        name: string;
        metric: "usd" | "total_tokens" | "llm_calls" | "tool_calls" | "tool_failures" | "events" | "latency_ms_max";
        value: number;
      }>;
    }) =>
      run(principal, "settings:write", async () => {
        await settings.set(ws, { traceThresholds: thresholds });
        return ok({ thresholds });
      }),
  );
}
