import type { PairRunnerInput, PairedRunner, RunnerMeta, RunnerStore } from "@assay/db";
import { z } from "zod";

// 셀프호스티드 러너 서비스 — 개인 소유 디바이스 페어링의 코어(페어/목록/해제/워크스페이스 로스터).
// HTTP 라우트와 MCP 도구가 공유한다(BFF↔MCP 패리티). 토큰은 페어 시 한 번만 평문 반환(저장은 해시).
// 디스패치/리스(MCP lease/result)는 이후 슬라이스 — 여기는 개인 소유 CRUD 만. 설계: docs/architecture/self-hosted-runner.md.

// 러너가 돌릴 수 있는 환경 — 이후 슬라이스의 잡 어피니티(케이스 env.kind ↔ capability) 매칭에 쓰인다.
export const RUNNER_CAPABILITIES = ["repo", "browser", "os-use", "docker"] as const;

// 페어 요청 바디(owner/workspace 는 Principal 에서 — 바디로 받지 않는다).
export const PairRunnerBodySchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(z.enum(RUNNER_CAPABILITIES)).optional(),
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
  // 워크스페이스 로스터(읽기 전용) — 이 워크스페이스에서 페어링된 러너 메타(토큰 없음). settings>멤버 탭용.
  async listForWorkspace(workspace: string): Promise<RunnerMeta[]> {
    return this.store.listByWorkspace(workspace);
  }
}
