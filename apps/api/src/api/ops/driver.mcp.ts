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

  const owned = async (family: DriverWorkflowFamily, id: string): Promise<boolean> => {
    if (family === "approval") {
      const approval = await deps.approvalService?.get(ws, id).catch(() => undefined);
      return approval !== undefined;
    }
    if (family === "reaper") {
      const run = await deps.service.get(id).catch(() => undefined);
      return run !== undefined && run.tenant === ws && run.kind === "sandbox";
    }
    if (family === "reaction") {
      // Ledger id = `<eventId>-<subscriptionId>`; the rule's row is the tenant's ownership proof (a deleted
      // rule hides its historical chains from the wrap — the coarse tradeoff of pointer-based scoping).
      const rule = await deps.subscriptionService?.get(ws, id.slice(-36)).catch(() => undefined);
      return rule !== undefined;
    }
    const record = await deps.scorecardService?.get(id);
    return record !== undefined && record?.tenant === ws;
  };

  server.registerTool(
    "describe_driver_workflow",
    {
      description:
        "Diagnose a durable driver workflow by LEDGER id (a scorecard/group id): lifecycle status, history " +
        "pressure, and each pending activity's retry state with its last failure — answers 'where is this " +
        "stuck, and why'. family: batch (driver loop) | score (detached scoring) | approval (durable WAIT) | reaper (session teardown timer) | reaction (durable multi-step reaction chain; id = <eventId>-<subscriptionId>).",
      inputSchema: {
        family: z.enum(DRIVER_WORKFLOW_FAMILIES),
        id: z.string().describe("the scorecard/group id (ledger vocabulary — never a raw workflowId)"),
      },
    },
    ({ family, id }: { family: DriverWorkflowFamily; id: string }) =>
      run(principal, "runtimes:read", async () => {
        if (!(await owned(family, id))) return fail("NOT_FOUND: no such record in this workspace.");
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
        if (!(await owned(family, id))) return fail("NOT_FOUND: no such record in this workspace.");
        await driverOps.cancel(family, id);
        return ok({ ok: true });
      }),
  );

  server.registerTool(
    "terminate_driver_workflow",
    {
      description:
        "Force-terminate a durable driver workflow by LEDGER id — for the workflow a cooperative cancel " +
        "cannot reach (a stuck handler, an unbounded-retry activity looping against a gone record). Never " +
        "writes the ledger; the recovery sweeps settle any row the dead workflow owned. Destructive (admin-only).",
      inputSchema: {
        family: z.enum(DRIVER_WORKFLOW_FAMILIES),
        id: z.string().describe("the scorecard/group id"),
      },
    },
    ({ family, id }: { family: DriverWorkflowFamily; id: string }) =>
      run(principal, "runtimes:control", async () => {
        if (!(await owned(family, id))) return fail("NOT_FOUND: no such record in this workspace.");
        await driverOps.terminate(family, id);
        return ok({ ok: true });
      }),
  );
}
