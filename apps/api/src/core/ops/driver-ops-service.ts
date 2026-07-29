import { AppError, NotFoundError, UpstreamError } from "@everdict/contracts";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";

// Driver ops surface v0 (docs/orchestration.md, the 044 adoption gate): the durable driver's lifecycle is
// readable and controllable ONLY through this everdict wrap — addressed by LEDGER vocabulary (a scorecard/group
// id, never a raw workflowId), role-gated at the route, and never a second control plane (raw gRPC stays
// unexposed). Families per ledger id: the batch driver loop, the detached scoring pass, and the durable
// approval WAIT (ledger id = the approval id). reaper:/reaction: join as their waves land.
export const DRIVER_WORKFLOW_FAMILIES = ["batch", "score", "approval"] as const;
export type DriverWorkflowFamily = (typeof DRIVER_WORKFLOW_FAMILIES)[number];

// The diagnostic slice an ops agent (or the web) needs to answer "where is this stuck, and why": lifecycle
// status, history pressure, and each in-flight activity's retry state with its LAST FAILURE — the log-level
// read that made the adoption gate pass (lesson 044: UI visibility = agent visibility, same public gRPC).
export interface DriverWorkflowStatus {
  family: DriverWorkflowFamily;
  ledgerId: string;
  workflowId: string;
  runId: string;
  status: string; // RUNNING | COMPLETED | FAILED | CANCELLED | TERMINATED | CONTINUED_AS_NEW | TIMED_OUT
  startTime?: string;
  closeTime?: string;
  historyLength?: number;
  pendingActivities: Array<{
    activityType: string;
    attempt?: number;
    lastFailure?: string;
  }>;
}

export class DriverOpsService {
  constructor(private readonly opts: { address: string; taskQueue?: string }) {}

  // Ledger id → deterministic workflowId — the correlation grammar (orchestration.md expansion disciplines).
  workflowIdFor(family: DriverWorkflowFamily, ledgerId: string): string {
    if (family === "batch") return `everdict-batch-${ledgerId}`;
    if (family === "score") return `everdict-score-${ledgerId}`;
    return `everdict-approval-${ledgerId}`;
  }

  async describe(family: DriverWorkflowFamily, ledgerId: string): Promise<DriverWorkflowStatus> {
    const workflowId = this.workflowIdFor(family, ledgerId);
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      const desc = await client.workflow.getHandle(workflowId).describe();
      const pending = (desc.raw.pendingActivities ?? []).map((a) => ({
        activityType: a.activityType?.name ?? "unknown",
        ...(a.attempt !== undefined && a.attempt !== null ? { attempt: a.attempt } : {}),
        ...(a.lastFailure?.message ? { lastFailure: a.lastFailure.message } : {}),
      }));
      return {
        family,
        ledgerId,
        workflowId,
        runId: desc.runId,
        status: desc.status.name,
        ...(desc.startTime ? { startTime: desc.startTime.toISOString() } : {}),
        ...(desc.closeTime ? { closeTime: desc.closeTime.toISOString() } : {}),
        ...(desc.historyLength !== undefined ? { historyLength: Number(desc.historyLength) } : {}),
        pendingActivities: pending,
      };
    } catch (err) {
      throw this.remap(err, workflowId);
    } finally {
      await connection.close();
    }
  }

  // Cooperative cancellation — the ledger record settles through the CP's own guards (a cancelled workflow's
  // in-queue activities skip on the CP-side terminal checks), so this never writes the ledger directly.
  async cancel(family: DriverWorkflowFamily, ledgerId: string): Promise<void> {
    const workflowId = this.workflowIdFor(family, ledgerId);
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.getHandle(workflowId).cancel();
    } catch (err) {
      throw this.remap(err, workflowId);
    } finally {
      await connection.close();
    }
  }

  // SDK failures are remapped to our error model (rule: monitoring blames us, never the raw SDK).
  private remap(err: unknown, workflowId: string): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof WorkflowNotFoundError)
      return new NotFoundError(
        "NOT_FOUND",
        { workflowId },
        "No driver workflow exists for this id (it never ran on Temporal, or retention expired).",
      );
    return new UpstreamError(
      "UPSTREAM_ERROR",
      { workflowId },
      `Temporal driver call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
