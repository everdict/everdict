import type { AgentJob, CaseResult } from "@assay/core";

// 백엔드의 동시 수용 능력. 스케줄러가 자기 in-flight 와 합산해 free 를 계산한다.
export interface BackendCapacity {
  total: number; // 동시 슬롯 상한 (정적 설정 또는 라이브 프로브)
  used: number; // 백엔드가 관측한 외부 사용량(모르면 0; 스케줄러가 자기 in-flight 를 추가 반영)
}

// "어디서 실행되나" 의 상위 레이어(placement). 컨트롤플레인이 백엔드들을 들고 잡을 라우팅한다.
// 격리는 각 백엔드의 런타임(Nomad task driver / K8s runtimeClass / Windows VM)이 제공.
export interface Backend {
  readonly id: string;
  capacity(): Promise<BackendCapacity>; // 용량 인지 배치용 — 동시 슬롯 여유
  dispatch(job: AgentJob): Promise<CaseResult>;
}

// (job)→CaseResult 디스패치 추상 — Router(정적)/Scheduler(용량인지)가 모두 만족.
// 오케스트레이터/액티비티는 구현이 아니라 이 인터페이스에 의존한다(드롭인 교체).
export interface Dispatcher {
  dispatch(job: AgentJob): Promise<CaseResult>;
}
