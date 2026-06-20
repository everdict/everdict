import { runAgentJob } from "@assay/agent";
import type { AgentJob, CaseResult } from "@assay/core";
import { DockerDriver } from "@assay/drivers";
import type { Backend, BackendCapacity } from "./backend.js";

// 단일 호스트 docker 백엔드 — 잡을 케이스의 env 이미지(EvalCase.image; 예: SWE-bench 공식 prebuilt) 컨테이너에서 실행한다.
// 에이전트를 이미지에 굽지 않고 DockerDriver(환경 컨테이너)로 하니스+채점을 그 안에서 돌린다. 격리는 docker 컨테이너.
export class DockerBackend implements Backend {
  readonly id = "docker";
  private readonly driver: DockerDriver;

  constructor(private readonly opts: { image?: string; maxConcurrent?: number | (() => number) } = {}) {
    this.driver = new DockerDriver(opts.image ? { defaultImage: opts.image } : {});
  }

  async capacity(): Promise<BackendCapacity> {
    const m = this.opts.maxConcurrent ?? 4;
    return { total: typeof m === "function" ? m() : m, used: 0 };
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    return runAgentJob(job, { driver: this.driver }); // 케이스를 컨테이너(case.image ?? 기본 image)에서 실행
  }
}
