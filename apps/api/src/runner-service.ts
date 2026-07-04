import { CapabilityNameSchema } from "@assay/core";
import type { PairRunnerInput, PairedRunner, RunnerMeta, RunnerStore } from "@assay/db";
import { z } from "zod";

// 셀프호스티드 러너 서비스 — 개인 소유 디바이스 페어링의 코어(페어/목록/해제/워크스페이스 로스터).
// HTTP 라우트와 MCP 도구가 공유한다(BFF↔MCP 패리티). 토큰은 페어 시 한 번만 평문 반환(저장은 해시).
// 디스패치/리스(MCP lease/result)는 이후 슬라이스 — 여기는 개인 소유 CRUD 만. 설계: docs/architecture/self-hosted-runner.md.

// 러너가 돌릴 수 있는 것 — core 어휘(CapabilityNameSchema) SSOT 와 동기화된 튜플(.options). z.enum 재료 겸
// setCapabilities known-set(어휘 밖 자가-광고 값은 버림). core 어휘가 바뀌면 여기도 자동으로 따라간다.
export const RUNNER_CAPABILITIES = CapabilityNameSchema.options;

// 페어 요청 바디(owner/workspace 는 Principal 에서 — 바디로 받지 않는다).
export const PairRunnerBodySchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(CapabilityNameSchema).optional(),
});
export type PairRunnerBody = z.infer<typeof PairRunnerBodySchema>;

export class RunnerService {
  constructor(private readonly store: RunnerStore) {}
  // 개인 소유: owner=principal.subject. 평문 토큰은 결과에 한 번만 실려 나간다(저장은 해시).
  async pair(input: PairRunnerInput): Promise<PairedRunner> {
    return this.store.pair(input);
  }
  // 개인 소유 — 어느 워크스페이스에서도 내 러너를 본다(프로필/연결과 동일 self-scoped).
  async list(owner: string): Promise<RunnerMeta[]> {
    return this.store.list(owner);
  }
  async revoke(owner: string, id: string): Promise<void> {
    await this.store.remove(owner, id);
  }
  // 러너 접속 표시(lease/heartbeat 시 lastSeenAt 갱신). 없는 러너면 no-op.
  async touch(owner: string, id: string): Promise<void> {
    await this.store.touch(owner, id);
  }
  // 러너 자가-광고 — 실제 capability(예: docker 데몬 감지)를 lease 때 보고. 알 수 없는 값은 버린다. 없는 러너 no-op.
  async setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void> {
    const known = new Set<string>(RUNNER_CAPABILITIES);
    await this.store.setCapabilities(owner, id, [...new Set(capabilities.filter((c) => known.has(c)))]);
  }
  // 워크스페이스 로스터(읽기 전용) — 이 워크스페이스에서 페어링된 러너 메타(토큰 없음). settings>멤버 탭용.
  async listForWorkspace(workspace: string): Promise<RunnerMeta[]> {
    return this.store.listByWorkspace(workspace);
  }
}
