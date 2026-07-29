import { ConflictError } from "@everdict/contracts";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

// Batch-on-Temporal driver — the control plane starts one durable scorecardBatchWorkflow per batch
// (docs/architecture/temporal-batch-orchestration.md). Uses only @temporalio/client (same rule as the schedule
// driver: the API process never pulls the worker's native binding). TASK_QUEUE must match the worker
// (@everdict/orchestrator constants.TASK_QUEUE = "everdict-eval").
const TASK_QUEUE = "everdict-eval";

export class TemporalBatchDriver {
  constructor(
    private readonly opts: {
      address: string;
      taskQueue?: string;
      // Settled cases per workflow execution before continue-as-new (EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY).
      // Unset = the workflow's own default (500) — the knob exists for history-budget tuning and live e2e.
      continueEvery?: number;
      rotateAtHistoryLength?: number; // history-pressure rotation floor (adaptive continue-as-new)
    },
  ) {}

  workflowIdFor(scorecardId: string): string {
    return `everdict-batch-${scorecardId}`;
  }

  async start(scorecardId: string): Promise<void> {
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.start("scorecardBatchWorkflow", {
        taskQueue: this.opts.taskQueue ?? TASK_QUEUE,
        workflowId: this.workflowIdFor(scorecardId),
        args: [
          {
            scorecardId,
            ...(this.opts.continueEvery !== undefined ? { continueEvery: this.opts.continueEvery } : {}),
            ...(this.opts.rotateAtHistoryLength !== undefined
              ? { rotateAtHistoryLength: this.opts.rotateAtHistoryLength }
              : {}),
          },
        ],
      });
    } finally {
      await connection.close();
    }
  }

  // Score-on-Temporal (orchestration.md T-c): the detached phase-2 pass as a durable score workflow. The
  // deterministic workflowId IS the one-pass-per-group dedup — a second start while one runs maps to a
  // client-visible 409; any other failure propagates for the caller's graceful in-process degrade.
  scoreWorkflowIdFor(groupId: string): string {
    return `everdict-score-${groupId}`;
  }

  async startScore(input: {
    groupId: string;
    judges: Array<{ id: string; version: string }>;
    submittedBy?: string;
  }): Promise<void> {
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.start("scoreGroupWorkflow", {
        taskQueue: this.opts.taskQueue ?? TASK_QUEUE,
        workflowId: this.scoreWorkflowIdFor(input.groupId),
        args: [
          {
            groupId: input.groupId,
            judges: input.judges,
            ...(input.submittedBy !== undefined ? { submittedBy: input.submittedBy } : {}),
            ...(this.opts.continueEvery !== undefined ? { continueEvery: this.opts.continueEvery } : {}),
            ...(this.opts.rotateAtHistoryLength !== undefined
              ? { rotateAtHistoryLength: this.opts.rotateAtHistoryLength }
              : {}),
          },
        ],
      });
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError)
        throw new ConflictError(
          "CONFLICT",
          { scorecard: input.groupId },
          "A scoring pass is already in flight (score workflow running).",
        );
      throw err;
    } finally {
      await connection.close();
    }
  }

  // Durable approval WAIT (orchestration.md T-a): one approval:<id> workflow per park — the deny-on-expiry
  // timer that survives every process. timeoutMs is computed at start (expiresAt − now); the workflow's
  // timer runs relative to its own start, so a small start latency only lengthens the window, never shortens
  // a decision's validity (expire skips a settled record).
  approvalWorkflowIdFor(approvalId: string): string {
    return `everdict-approval-${approvalId}`;
  }

  async startApproval(input: { approvalId: string; tenant: string; expiresAt: string }): Promise<void> {
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      const timeoutMs = Math.max(1000, new Date(input.expiresAt).getTime() - Date.now());
      await client.workflow.start("approvalWorkflow", {
        taskQueue: this.opts.taskQueue ?? TASK_QUEUE,
        workflowId: this.approvalWorkflowIdFor(input.approvalId),
        args: [{ approvalId: input.approvalId, tenant: input.tenant, timeoutMs }],
      });
    } finally {
      await connection.close();
    }
  }

  // Prompt completion on decide — best-effort; a missed signal just lets the timer fire a no-op at TTL.
  async signalApprovalDecided(approvalId: string): Promise<void> {
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.getHandle(this.approvalWorkflowIdFor(approvalId)).signal("decided");
    } finally {
      await connection.close();
    }
  }

  // Cooperative cancellation for a superseded batch — best-effort (the record is already terminal; in-queue
  // activities also skip on the CP-side superseded guard).
  async cancel(scorecardId: string): Promise<void> {
    const connection = await Connection.connect({ address: this.opts.address });
    try {
      const client = new Client({ connection });
      await client.workflow.getHandle(this.workflowIdFor(scorecardId)).cancel();
    } finally {
      await connection.close();
    }
  }
}
