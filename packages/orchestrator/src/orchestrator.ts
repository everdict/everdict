import type { Router } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import { Client, Connection } from "@temporalio/client";
import { TASK_QUEUE } from "./constants.js";

// 컨트롤플레인이 한 케이스를 실행하는 추상화. 직접(Direct) 또는 durable(Temporal).
export interface Orchestrator {
  run(job: AgentJob): Promise<CaseResult>;
}

// 비-durable: 같은 프로세스에서 Router 직접 호출 (개발/단순).
export class DirectOrchestrator implements Orchestrator {
  constructor(private readonly router: Router) {}
  run(job: AgentJob): Promise<CaseResult> {
    return this.router.dispatch(job);
  }
}

export interface TemporalOrchestratorOptions {
  address?: string;
  taskQueue?: string;
}

// durable: Temporal 워크플로로 실행(클라이언트 측). 워커가 실제 디스패치를 수행한다.
// 워크플로는 이름(string)으로 시작 → 클라이언트가 워크플로 sandbox 코드를 import 하지 않는다.
export class TemporalOrchestrator implements Orchestrator {
  constructor(private readonly opts: TemporalOrchestratorOptions = {}) {}

  async run(job: AgentJob): Promise<CaseResult> {
    const connection = await Connection.connect({ address: this.opts.address ?? "localhost:7233" });
    try {
      const client = new Client({ connection });
      const handle = await client.workflow.start<(j: AgentJob) => Promise<CaseResult>>("evalCaseWorkflow", {
        taskQueue: this.opts.taskQueue ?? TASK_QUEUE,
        workflowId: `assay-${job.evalCase.id}-${process.pid}`,
        args: [job],
      });
      return await handle.result();
    } finally {
      await connection.close();
    }
  }
}
