import type { Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/contracts";
import { Client, Connection } from "@temporalio/client";
import { TASK_QUEUE } from "./constants.js";

// Abstraction for how the control plane runs a single case. Direct or durable (Temporal).
export interface Orchestrator {
  run(job: AgentJob): Promise<CaseResult>;
}

// Non-durable: call the Dispatcher (Router/Scheduler) directly in the same process (dev/simple).
export class DirectOrchestrator implements Orchestrator {
  constructor(private readonly dispatcher: Dispatcher) {}
  run(job: AgentJob): Promise<CaseResult> {
    return this.dispatcher.dispatch(job);
  }
}

export interface TemporalOrchestratorOptions {
  address?: string;
  taskQueue?: string;
}

// Durable: runs as a Temporal workflow (client side). The worker performs the actual dispatch.
// The workflow is started by name (string) → the client does not import the workflow sandbox code.
export class TemporalOrchestrator implements Orchestrator {
  constructor(private readonly opts: TemporalOrchestratorOptions = {}) {}

  async run(job: AgentJob): Promise<CaseResult> {
    const connection = await Connection.connect({ address: this.opts.address ?? "localhost:7233" });
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start<(j: AgentJob) => Promise<CaseResult>>("evalCaseWorkflow", {
        taskQueue: this.opts.taskQueue ?? TASK_QUEUE,
        workflowId: `everdict-${job.evalCase.id}-${process.pid}`,
        args: [job],
      });
      return await handle.result();
    } finally {
      await connection.close();
    }
  }
}
