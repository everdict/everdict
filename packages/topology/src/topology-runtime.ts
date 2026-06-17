import type { BrowserSnapshot, ServiceHarnessSpec } from "@assay/core";

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
// (구체 NomadTopologyRuntime/K8sTopologyRuntime 의 라이브 apply 는 Phase 2)
export interface TopologyRuntime {
  readonly id: string;
  ensureTopology(spec: ServiceHarnessSpec): Promise<TopologyHandle>; // warm 서비스+공유 스토어 보장
  provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string): Promise<BrowserEnvHandle>; // per-case
}
