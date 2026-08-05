import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { DEFAULT_PULSE_DAYS } from "./pulse.routes.js";

// MCP twin of GET /workspace/pulse (BFF↔MCP parity) — "how is this workspace doing", in one call.
// The agent asks this for the same reason a person opens the home screen: before doing anything else, find out
// what is open, what is running, and which way the numbers have been moving.
export function registerWorkspacePulseTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.workspacePulseService) return;
  const pulse = deps.workspacePulseService;

  server.registerTool(
    "get_workspace_pulse",
    {
      description:
        "How the workspace is doing right now, plus its trend: open/in-progress/regressed issues, active cycles " +
        "and how much of what they committed to is done, goals and projects flagged at risk, unfinished agent " +
        "tasks and approvals waiting on a human, and the evals' pass rate against the previous window. The trend " +
        "series (activity by axis, issue flow in/out, pass rate per day) comes from the platform-event log. Start " +
        "here when asked what is going on, what needs attention, or whether things are improving.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe(`trend window in days, today included (default ${DEFAULT_PULSE_DAYS})`),
      },
    },
    ({ days }) =>
      run(principal, "issues:read", async () => {
        const visibleTeams = await visibleTeamsFor(deps, principal);
        return ok(
          await pulse.read({
            tenant: ws,
            days: days ?? DEFAULT_PULSE_DAYS,
            ...(visibleTeams !== undefined ? { visibleTeams } : {}),
          }),
        );
      }),
  );
}
