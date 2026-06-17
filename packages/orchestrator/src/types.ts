import type { AgentJob, CaseResult } from "@assay/core";

// 워크플로가 호출하는 액티비티 시그니처(순수 타입 — 워크플로 번들에 안전하게 import 됨).
export interface Activities {
  dispatchCase(job: AgentJob): Promise<CaseResult>;
}
