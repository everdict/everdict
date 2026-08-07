import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// MCP twin of GET /workspace/ops-report (BFF↔MCP parity) — the workspace's own execution health, the
// platform's failure share separated from the product's.
export function registerWorkspaceOpsReportTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.scorecardService) return;
  const scorecards = deps.scorecardService;

  server.registerTool(
    "get_workspace_ops_report",
    {
      description:
        "The workspace's execution health over a window: batch fates, case-fate sums (CaseOutcome vocabulary), " +
        "infra-failure/unmeasured/trace-seal rates, and evidence-plane tallies — the platform's failure share " +
        "separated from the product's ('our fault vs the harness's fault'). Every rate is ABSENT when its " +
        "denominator is zero — never read a missing rate as 0%. Use it when eval results look unreliable: it " +
        "answers whether the platform or the harness is to blame.",
      inputSchema: {
        from: z.string().optional().describe("ISO lower bound on createdAt (inclusive)"),
        to: z.string().optional().describe("ISO upper bound on createdAt (inclusive)"),
      },
    },
    ({ from, to }) =>
      run(principal, "scorecards:read", async () => {
        const visibleTeams = await visibleTeamsFor(deps, principal);
        return ok(
          await scorecards.opsReport(ws, {
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
            ...(visibleTeams !== undefined ? { visibleTeams } : {}),
          }),
        );
      }),
  );
}
