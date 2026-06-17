import type { AgentJob, CaseResult } from "@assay/core";

// "어디서 실행되나" 의 상위 레이어(placement). 컨트롤플레인이 백엔드들을 들고 잡을 라우팅한다.
// 격리는 각 백엔드의 런타임(Nomad task driver / K8s runtimeClass / Windows VM)이 제공.
export interface Backend {
  readonly id: string;
  dispatch(job: AgentJob): Promise<CaseResult>;
}
