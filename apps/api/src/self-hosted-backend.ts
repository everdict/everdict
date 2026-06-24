import type { Backend, BackendCapacity, ProbeResult } from "@assay/backends";
import { type AgentJob, type CaseResult, UpstreamError } from "@assay/core";

// 셀프호스티드 러너 디스패치 키 — 잡이 흘러갈 러너의 정체성. lease 큐는 (tenant, owner, runnerId)로 키된다(D3).
export interface SelfHostedKey {
  tenant: string;
  owner: string; // 러너 소유자 = principal.subject
  runnerId: string;
}

export function selfHostedBackendName(key: SelfHostedKey): string {
  return `self:${key.tenant}:${key.owner}:${key.runnerId}`;
}

// Slice 2 스텁 — placement.target=self:<runnerId> 선택/라우팅 경로만 깐다("selection only").
// 실제 lease 큐(러너가 잡을 가져가고 결과를 회신)는 Slice 3 의 SelfHostedBackend 로 교체된다.
// 지금은 디스패치가 명시적 UpstreamError 로 끝나 "선택은 되지만 아직 연결 안 됨"을 분명히 한다(무한 큐잉/행 방지).
// 설계: docs/architecture/self-hosted-runner.md.
export class SelfHostedStubBackend implements Backend {
  readonly id: string;
  constructor(private readonly key: SelfHostedKey) {
    this.id = selfHostedBackendName(key);
  }
  // total:1 — 스케줄러가 큐잉하지 않고 즉시 dispatch 를 시도하게 한다(스텁이 곧장 명시적 에러를 던지도록).
  async capacity(): Promise<BackendCapacity> {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: AgentJob): Promise<CaseResult> {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { runnerId: this.key.runnerId, reason: "self_hosted_not_connected" },
      "셀프호스티드 러너 디스패치는 아직 구현되지 않았습니다(slice 3). 러너 클라이언트가 연결되면 이 잡을 가져갑니다.",
    );
  }
  async probe(): Promise<ProbeResult> {
    return { reachable: false, detail: "self-hosted runner lease 미구현(slice 3)" };
  }
}
