import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BudgetLimitInputSchema } from "../lib/budget-tracker.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Billing resource MCP tools — the MCP twin of billing.routes.ts (usage meter + enforcement budget).
export function registerBillingTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.usageMeter) {
    const usageMeter = deps.usageMeter;
    server.registerTool(
      "get_usage",
      {
        description:
          "The workspace's metered billing usage — LLM cost (usd/tokens) + evaluations for orchestration + verdict (harness under test + eval/judge model), split by source. Own-pays (personal self-hosted) runs are excluded (BYO compute). Meter-only — this never blocks a run.",
        inputSchema: {},
      },
      () => run(principal, "scorecards:read", async () => ok(usageMeter.usage(ws))),
    );
  }

  if (deps.budget) {
    const budget = deps.budget;
    const budgetView = () => ({ usage: budget.usage(ws), limit: budget.limitOf(ws) ?? null });
    server.registerTool(
      "get_budget",
      {
        description:
          "The workspace's enforcement budget — committed usage (runs/usd/tokens) plus the per-tenant limit (a null dimension = unlimited). Distinct from get_usage (meter-only): this budget BLOCKS a run with 402 once a cap is hit. Readable by members; only admins change the limit (set_budget_limit).",
        inputSchema: {},
      },
      () => run(principal, "scorecards:read", async () => ok(budgetView())),
    );
    server.registerTool(
      "set_budget_limit",
      {
        description:
          "Set this workspace's enforcement budget limit (admin). Each of usd/tokens/runs is optional; an omitted dimension is unlimited. Replaces the whole limit.",
        inputSchema: BudgetLimitInputSchema.shape,
      },
      (args) =>
        run(principal, "settings:write", async () => {
          await budget.setLimit(ws, BudgetLimitInputSchema.parse(args));
          return ok(budgetView());
        }),
    );
  }
}
