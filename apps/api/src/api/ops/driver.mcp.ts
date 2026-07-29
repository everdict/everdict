import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DRIVER_WORKFLOW_FAMILIES, type DriverWorkflowFamily } from "../../core/ops/driver-ops-service.js";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Driver ops MCP tools — the ops agent's read/control over the durable driver (lesson-044 adoption gate:
// UI visibility = agent visibility). Same core, same ledger-vocabulary addressing as driver.routes.ts.
export function registerDriverOpsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.driverOps) return;
  const driverOps = deps.driverOps;

  const owned = async (id: string): Promise<boolean> => {
    const record = await deps.scorecardService?.get(id);
    return record !== undefined && record?.tenant === ws;
  };

  server.registerTool(
    "describe_driver_workflow",
    {
      description:
        "Diagnose a durable driver workflow by LEDGER id (a scorecard/group id): lifecycle status, history " +
        "pressure, and each pending activity's retry state with its last failure — answers 'where is this " +
        "stuck, and why'. family: batch (the batch driver loop) | score (a detached scoring pass).",
      inputSchema: {
        family: z.enum(DRIVER_WORKFLOW_FAMILIES),
        id: z.string().describe("the scorecard/group id (ledger vocabulary — never a raw workflowId)"),
      },
    },
    ({ family, id }: { family: DriverWorkflowFamily; id: string }) =>
      run(principal, "runtimes:read", async () => {
        if (!(await owned(id))) return fail("NOT_FOUND: no such record in this workspace.");
        return ok(await driverOps.describe(family, id));
      }),
  );

  server.registerTool(
    "cancel_driver_workflow",
    {
      description:
        "Cooperatively cancel a durable driver workflow by LEDGER id — the record settles through the control " +
        "plane's own terminal guards. Destructive (admin-only), same posture as live-cluster runtime control.",
      inputSchema: {
        family: z.enum(DRIVER_WORKFLOW_FAMILIES),
        id: z.string().describe("the scorecard/group id"),
      },
    },
    ({ family, id }: { family: DriverWorkflowFamily; id: string }) =>
      run(principal, "runtimes:control", async () => {
        if (!(await owned(id))) return fail("NOT_FOUND: no such record in this workspace.");
        await driverOps.cancel(family, id);
        return ok({ ok: true });
      }),
  );
}
