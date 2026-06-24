import type { Backend, BackendCapacity, ProbeResult } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import { type RunnerHub, type SelfHostedKey, selfHostedBackendName } from "./runner-hub.js";

// 개인 소유 셀프호스티드 러너 백엔드 — push 가 아니라 pull. dispatch(job)는 RunnerHub 에 잡을 파킹하고
// promise 를 돌려준다. 러너 클라이언트(assay runner)가 MCP lease 로 가져가 자기 머신에서 돌리고 결과를
// 회신하면 그 promise 가 resolve 된다. 백엔드 인스턴스는 러너별(=key)로 RuntimeDispatcher 가 등록한다.
// 설계: docs/architecture/self-hosted-runner.md.
export class SelfHostedBackend implements Backend {
  readonly id: string;
  constructor(
    private readonly key: SelfHostedKey,
    private readonly hub: RunnerHub,
    // 러너당 동시 파킹 상한 — 스케줄러 게이팅용(파킹은 실자원을 안 쓰니 넉넉히; 실제 직렬화는 lease 가용성이 한다).
    private readonly maxConcurrent = 8,
  ) {
    this.id = selfHostedBackendName(key);
  }
  async capacity(): Promise<BackendCapacity> {
    // used 는 스케줄러가 자기 in-flight 로 반영하므로 0(여기선 파킹 큐가 실 대기를 흡수).
    return { total: this.maxConcurrent, used: 0 };
  }
  dispatch(job: AgentJob): Promise<CaseResult> {
    return this.hub.enqueue(this.key, job);
  }
  // 잡 없이 "러너가 붙어 있나"를 단정할 수단이 (Slice 3 엔) 없다 — pull 모델이라 연결 상태는 lease 폴링으로만 드러난다.
  // 대기 중 잡 수만 보고한다(붙어 있으면 곧 빠진다). 정밀 presence/heartbeat 는 Slice 6.
  async probe(): Promise<ProbeResult> {
    const pending = this.hub.pending(this.key);
    return { reachable: true, detail: `self-hosted runner (pull); pending jobs: ${pending}` };
  }
}
