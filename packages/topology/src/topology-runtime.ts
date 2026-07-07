import type { EnvSnapshot, ServiceHarnessSpec, TrustZone } from "@everdict/core";

// warm 토폴로지 핸들: 서비스 이름 → 베이스 URL (front-door 등).
export interface TopologyHandle {
  endpoints: Record<string, string>;
}

// per-case 타깃 환경 핸들 — 에이전트가 도달할 "이름있는 좌표"(wiring) + 관측 표면.
// wiring 은 per-run 와이어링 어휘에 머지된다 → bodyTemplate 이 타깃이 선언한 임의 좌표를 {{...}} 로 참조.
// CDP 브라우저는 1-원소 bag({ target_cdp_url })인 특수 케이스. 세션형 타깃은 여러 좌표를 동시에 기여
// (playwright_server_url/action_stream_url/session_id…). 설계: docs/architecture/target-acquisition-generalization.md.
export interface TargetEnvHandle {
  wiring: Record<string, string>;
  snapshot(): Promise<EnvSnapshot>;
  dispose(): Promise<void>;
}

// 오케스트레이터별 토폴로지 배포/디스커버리만 담당. Nomad/K8s 구현이 갈리는 지점.
// trustZone 이 주어지면 warm 풀을 테넌트(존)별로 분리하고 네임스페이스/격리를 적용한다
// — 평가는 임의 코드 실행이므로 warm 토폴로지를 테넌트 간 공유하면 안 된다.
export interface TopologyRuntime {
  readonly id: string;
  ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle>; // warm(존별)
  provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<TargetEnvHandle>; // per-case
}
