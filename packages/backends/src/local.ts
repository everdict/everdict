import { runAgentJob } from "@assay/agent";
import type { AgentJob, CaseResult } from "@assay/core";
import type { Backend, BackendCapacity, ProbeResult } from "./backend.js";

// 개발/단일 호스트용 — 잡을 같은 프로세스에서 실행한다(격리 없음).
// claude 는 이 머신의 구독 로그인을 사용.
export class LocalBackend implements Backend {
  readonly id = "local";
  // maxConcurrent 는 함수도 가능 — 오토스케일러가 동적으로 바꾸는 슬롯을 읽게 한다.
  constructor(private readonly maxConcurrent: number | (() => number) = 4) {}

  async capacity(): Promise<BackendCapacity> {
    // in-process 실행 — 슬롯은 설정값, 사용량은 스케줄러의 in-flight 로 게이팅.
    const total = typeof this.maxConcurrent === "function" ? this.maxConcurrent() : this.maxConcurrent;
    return { total, used: 0 };
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    return runAgentJob(job);
  }

  // in-process — 클러스터가 없으니 항상 도달 가능(컨트롤플레인 호스트 자신).
  async probe(): Promise<ProbeResult> {
    return { reachable: true, detail: "in-process (control-plane host)" };
  }
}
