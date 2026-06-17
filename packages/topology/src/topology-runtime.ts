import type { BrowserSnapshot, ServiceHarnessSpec, TrustZone } from "@assay/core";

// warm 토폴로지 핸들: 서비스 이름 → 베이스 URL (front-door 등).
export interface TopologyHandle {
  endpoints: Record<string, string>;
}

// per-case 타깃 환경(브라우저+익스텐션) 핸들.
export interface BrowserEnvHandle {
  cdpUrl: string;
  snapshot(): Promise<BrowserSnapshot>;
  dispose(): Promise<void>;
}

// 오케스트레이터별 토폴로지 배포/디스커버리만 담당. Nomad/K8s 구현이 갈리는 지점.
// trustZone 이 주어지면 warm 풀을 테넌트(존)별로 분리하고 네임스페이스/격리를 적용한다
// — 평가는 임의 코드 실행이므로 warm 토폴로지를 테넌트 간 공유하면 안 된다.
export interface TopologyRuntime {
  readonly id: string;
  ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle>; // warm(존별)
  provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<BrowserEnvHandle>; // per-case
}
