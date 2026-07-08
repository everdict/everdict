import { Client, Connection } from "@temporalio/client";

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
          },
        ],
      });
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
