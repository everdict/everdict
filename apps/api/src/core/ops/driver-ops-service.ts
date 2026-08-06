import { AppError, BadRequestError, NotFoundError, UpstreamError } from "@everdict/contracts";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";

// Driver ops surface v0 (docs/orchestration.md, the 044 adoption gate): the durable driver's lifecycle is
// readable and controllable ONLY through this everdict wrap — addressed by LEDGER vocabulary (a scorecard/group
// id, never a raw workflowId), role-gated at the route, and never a second control plane (raw gRPC stays
// unexposed). Families per ledger id: the batch driver loop, the detached scoring pass, and the durable
// approval WAIT (ledger id = the approval id), and the durable session reaper (ledger id = the sandbox
// run id — W5's T-b). reaction: joins with its wave.
export const DRIVER_WORKFLOW_FAMILIES = ["batch", "score", "approval", "reaper", "reaction"] as const;
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

// One row of the operator's workflow inventory. family/ledgerId are parsed back out of the deterministic
// workflowId grammar where it applies; a schedule FIRE workflow (whose id Temporal suffixes with the nominal
// fire time) maps to family "schedule" with the schedule id as its ledger id.
export interface DriverWorkflowSummary {
  workflowId: string;
  type: string;
  status: string;
  startTime?: string;
  closeTime?: string;
  family?: DriverWorkflowFamily | "schedule";
  ledgerId?: string;
}

// The workflowId grammar, inverted (workflowIdFor is the forward direction). Longest prefix first so
// `everdict-sched-run-` never half-matches a shorter family.
const WORKFLOW_ID_PREFIXES: Array<{ prefix: string; family: DriverWorkflowFamily | "schedule" }> = [
  { prefix: "everdict-sched-run-", family: "schedule" },
  { prefix: "everdict-reaction-", family: "reaction" },
  { prefix: "everdict-approval-", family: "approval" },
  { prefix: "everdict-reaper-", family: "reaper" },
  { prefix: "everdict-batch-", family: "batch" },
  { prefix: "everdict-score-", family: "score" },
];

export function parseDriverWorkflowId(
  workflowId: string,
): { family: DriverWorkflowFamily | "schedule"; ledgerId: string } | undefined {
  for (const { prefix, family } of WORKFLOW_ID_PREFIXES) {
    if (!workflowId.startsWith(prefix)) continue;
    const rest = workflowId.slice(prefix.length);
    // A schedule fire's id carries the nominal fire time after the schedule id (Temporal Schedules append
    // it) — strip it so the ledger id addresses the schedule record: <uuid>-<ISO time>.
    if (family === "schedule") return { family, ledgerId: rest.length > 36 ? rest.slice(0, 36) : rest };
    return { family, ledgerId: rest };
  }
  return undefined;
}

export class DriverOpsService {
  constructor(private readonly opts: { address: string; taskQueue?: string }) {}

  // Ledger id → deterministic workflowId — the correlation grammar (orchestration.md expansion disciplines).
  workflowIdFor(family: DriverWorkflowFamily, ledgerId: string): string {
    if (family === "batch") return `everdict-batch-${ledgerId}`;
    if (family === "score") return `everdict-score-${ledgerId}`;
    if (family === "reaper") return `everdict-reaper-${ledgerId}`;
    if (family === "reaction") return `everdict-reaction-${ledgerId}`; // ledgerId = `<eventId>-<subscriptionId>`
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

  // Force-termination — for the workflow cancel cannot reach (a handler stuck before its first await, an
  // unbounded-retry activity looping against a gone record). The server stops the execution outright; like
  // cancel, this never writes the ledger — the sweeps settle any row the dead workflow was responsible for.
  async terminate(family: DriverWorkflowFamily, ledgerId: string, reason?: string): Promise<void> {
    await this.terminateRaw(this.workflowIdFor(family, ledgerId), reason);
  }

  // Terminate by RAW workflowId — the operator's zombie killer (a leaked workflow may have no ledger record
  // left to address it by). Refuses anything outside the everdict- family: this wrap is never a second
  // control plane for foreign workflows sharing the namespace.
  async terminateRaw(workflowId: string, reason?: string): Promise<void> {
    if (!workflowId.startsWith("everdict-"))
      throw new BadRequestError(
        "BAD_REQUEST",
        { workflowId },
        "Only everdict-managed workflows (everdict-*) can be terminated through this surface.",
      );
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.getHandle(workflowId).terminate(reason ?? "terminated via the everdict ops surface");
    } catch (err) {
      throw this.remap(err, workflowId);
    } finally {
      await connection.close();
    }
  }

  // Every everdict-managed workflow the driver currently knows (newest first, capped) — the operator's
  // zombie inventory. `status: "running"` narrows to live executions; "all" includes the recently closed
  // (retention-bound), whose Failed rows are how a leaked schedule announces itself.
  async list(opts: { status?: "running" | "all"; limit?: number } = {}): Promise<DriverWorkflowSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      const iter = client.workflow.list(opts.status === "running" ? { query: `ExecutionStatus="Running"` } : undefined);
      const out: DriverWorkflowSummary[] = [];
      for await (const info of iter) {
        if (!info.workflowId.startsWith("everdict-")) continue; // foreign workflows sharing the namespace
        const parsed = parseDriverWorkflowId(info.workflowId);
        out.push({
          workflowId: info.workflowId,
          type: info.type,
          status: info.status.name,
          ...(info.startTime ? { startTime: info.startTime.toISOString() } : {}),
          ...(info.closeTime ? { closeTime: info.closeTime.toISOString() } : {}),
          ...(parsed !== undefined ? parsed : {}),
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err) {
      throw this.remap(err, "list");
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
