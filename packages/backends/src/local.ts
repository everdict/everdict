import { runAgentJob } from "@assay/agent";
import type { AgentJob, CaseResult } from "@assay/core";
import type { Backend } from "./backend.js";

// 개발/단일 호스트용 — 잡을 같은 프로세스에서 실행한다(격리 없음).
// claude 는 이 머신의 구독 로그인을 사용.
export class LocalBackend implements Backend {
  readonly id = "local";
  dispatch(job: AgentJob): Promise<CaseResult> {
    return runAgentJob(job);
  }
}
