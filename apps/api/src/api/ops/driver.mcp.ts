import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DRIVER_WORKFLOW_FAMILIES,
  type DriverWorkflowAddress,
  type DriverWorkflowFamily,
} from "../../core/ops/driver-ops-service.js";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Driver ops MCP tools — the ops agent's read/control over the durable driver (lesson-044 adoption gate:
// UI visibility = agent visibility). Same core, same ledger-vocabulary addressing as driver.routes.ts.
export function registerDriverOpsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.driverOps) return;
  const driverOps = deps.driverOps;

  // The family's OWN ledger decides both ownership and the address. A score pass is addressed by the workflow id its
  // marker recorded when the driver started it; a record with no Temporal pass in flight has nothing to address.
  const addressFor = async (family: DriverWorkflowFamily, id: string): Promise<DriverWorkflowAddress | undefined> => {
    if (family === "approval") {
      const approval = await deps.approvalService?.get(ws, id).catch(() => undefined);
      return approval !== undefined ? { family, ledgerId: id } : undefined;
    }
    if (family === "reaper") {
      const run = await deps.service.get(id).catch(() => undefined);
      return run !== undefined && run.tenant === ws && run.kind === "sandbox" ? { family, ledgerId: id } : undefined;
    }
    if (family === "reaction") {
      // Ledger id = `<eventId>-<subscriptionId>`; the rule's row is the tenant's ownership proof (a deleted
      // rule hides its historical chains from the wrap — the coarse tradeoff of pointer-based scoping).
      const rule = await deps.subscriptionService?.get(ws, id.slice(-36)).catch(() => undefined);
      return rule !== undefined ? { family, ledgerId: id } : undefined;
    }
    const record = await deps.scorecardService?.get(id);
    if (record === undefined || record.tenant !== ws) return undefined;
    if (family === "batch") return { family, ledgerId: id };
    const workflowId = record.scoringPass?.workflowId;
    return workflowId !== undefined ? { family, ledgerId: id, workflowId } : undefined;
  };
  const notFound = (family: DriverWorkflowFamily) =>
    fail(
      family === "score"
        ? "NOT_FOUND: no such record in this workspace, or no Temporal scoring pass is in flight for it."
        : "NOT_FOUND: no such record in this workspace.",
    );

  server.registerTool(
    "describe_driver_workflow",
    {
      annotations: { readOnlyHint: true },
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
        const address = await addressFor(family, id);
        if (!address) return notFound(family);
        return ok(await driverOps.describe(address));
      }),
  );

  server.registerTool(
    "cancel_driver_workflow",
    {
      annotations: { readOnlyHint: false },
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
        const address = await addressFor(family, id);
        if (!address) return notFound(family);
        await driverOps.cancel(address);
        return ok({ ok: true });
      }),
  );

  server.registerTool(
    "terminate_driver_workflow",
    {
      annotations: { readOnlyHint: false },
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
        const address = await addressFor(family, id);
        if (!address) return notFound(family);
        await driverOps.terminate(address);
        return ok({ ok: true });
      }),
  );
}
