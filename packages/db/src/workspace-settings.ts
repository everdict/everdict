import { JudgeRunConfigSchema } from "@assay/core";
import { z } from "zod";
import type { SqlClient } from "./client.js";

// CI repo link — repository ↔ 하니스 서비스 슬롯 매핑 + GitHub Actions OIDC trust policy 를 겸하는 한 레코드.
// link 의 "존재"가 그 레포의 GitHub OIDC 토큰을 이 워크스페이스로 신뢰한다(별도 정책 화면 없음 — zero-input).
// 발사 시점 인증은 레포 기반 페더레이션이라 개인 토큰 불사용 → creator-left 문제 없음(createdBy 는 감사용).
// 설계: docs/architecture/github-actions-trigger.md (D3).
export const WorkspaceCiLinkSchema = z.object({
  repository: z.string().min(1), // "owner/name" (대소문자 무시 비교)
  host: z.string().optional(), // 미지정 = github.com (GHES 페더레이션은 후속)
  harness: z.string().min(1), // 하니스 인스턴스 id
  dataset: z.string().optional(), // CI 가 발사할 데이터셋 id — setup-PR 워크플로 생성에 사용
  // 서비스 슬롯 → 모노레포 path filter(선택). 이 레포의 CI 가 갈아끼우는 슬롯들.
  slots: z.record(z.object({ path: z.string().optional() })).default({}),
  createdBy: z.string(), // 감사용(발사 인증과 무관)
  disabled: z.boolean().optional(),
  // 셀프호스티드 배치(선택) — setup-PR 워크플로가 직접 자가 러너를 타깃하게. 미지정 = ubuntu-latest + 관리형 런타임.
  runsOn: z.string().optional(), // 워크플로 runs-on 값(예: "[self-hosted, assay-<id>]"). github-install 의 러너 라벨.
  runtime: z.string().optional(), // run-eval runtime 입력(예: "self:ws:<id>"). 이 레포 평가를 그 워크스페이스-공유 러너에서.
});
export type WorkspaceCiLink = z.infer<typeof WorkspaceCiLinkSchema>;

// 워크스페이스 단위 설정(컨트롤플레인 정책). JSONB 로 저장해 추후 확장 용이.
// 요청별 override(POST /runs·/scorecards body.*)가 이보다 우선; 이 값은 env 기본 정책을 덮어쓴다.
export const WorkspaceSettingsSchema = z.object({
  meterUsage: z.boolean().optional(), // 미지정이면 env 정책(ASSAY_METER_TENANTS/ASSAY_METER_USAGE) 폴백
  // inline judge grader(예: WebVoyager 프리셋) 채점에 쓸 기본 모델. 컨트롤플레인이 잡(job.judge)으로 자동 주입.
  // 키는 시크릿(SecretStore)에서 별도 주입, 여기엔 모델/프로바이더만(시크릿 아님). 요청별 override 가 우선.
  judge: JudgeRunConfigSchema.optional(),
  // run/scorecard 완료 알림 대상 — Mattermost 외부 계정 연결(connectionId) + 채널(channelId) + 연결 소유자(ownerSubject).
  // 연결은 이제 개인 소유(owner=subject)라 워크스페이스 알림이 어느 연결을 쓸지 모호 → notify 를 설정한 사람의 subject 를
  // 서버에서 ownerSubject 로 박아둔다(클라이언트가 못 보냄). 완료 시 그 owner 의 토큰으로 채널에 게시. ownerSubject 없으면 skip.
  // (토큰/채널 값은 저장 안 함 — id 참조만.)
  notify: z.object({ connectionId: z.string(), channelId: z.string(), ownerSubject: z.string().optional() }).optional(),
  // self-hosted 외부 계정 연결(GitHub Enterprise/Mattermost)의 워크스페이스-레벨 OAuth 앱 설정 — provider id → 자격증명.
  // 관리자가 1회 등록하면(Settings → 통합) 멤버는 client ID 입력 없이 원클릭으로 연결한다(Linear 방식). 값은 비밀 아님:
  // host(서버 URL) + clientId(공개 OAuth app id) + clientSecretName(SecretStore 키 이름 — client_secret 값 자체는 저장 안 함).
  integrations: z
    .record(
      z.string(), // provider id: github-enterprise | mattermost
      z.object({ host: z.string().url(), clientId: z.string().min(1), clientSecretName: z.string().min(1) }),
    )
    .optional(),
  // CI 통합(GitHub Actions) — repo link 목록(레포↔하니스 슬롯 매핑 = OIDC trust policy). 위 WorkspaceCiLinkSchema 참고.
  ci: z.object({ links: z.array(WorkspaceCiLinkSchema).default([]) }).optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
// 워크스페이스 통합 1건의 자격증명(provider별). 전부 비밀 아님(반환 안전) — clientSecret 값은 SecretStore 에만.
export type WorkspaceIntegrationConfig = NonNullable<WorkspaceSettings["integrations"]>[string];

export interface WorkspaceSettingsStore {
  get(workspace: string): Promise<WorkspaceSettings | undefined>;
  set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings>; // 부분 병합 upsert
}

export class InMemoryWorkspaceSettingsStore implements WorkspaceSettingsStore {
  private readonly byWs = new Map<string, WorkspaceSettings>();
  async get(workspace: string): Promise<WorkspaceSettings | undefined> {
    const s = this.byWs.get(workspace);
    return s ? { ...s } : undefined;
  }
  async set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings> {
    const next = { ...(this.byWs.get(workspace) ?? {}), ...patch };
    this.byWs.set(workspace, next);
    return { ...next };
  }
}

export class PgWorkspaceSettingsStore implements WorkspaceSettingsStore {
  constructor(private readonly client: SqlClient) {}
  async get(workspace: string): Promise<WorkspaceSettings | undefined> {
    const r = await this.client.query<{ settings: unknown }>(
      "SELECT settings FROM assay_workspace_settings WHERE workspace = $1",
      [workspace],
    );
    return r.rows[0] ? WorkspaceSettingsSchema.parse(r.rows[0].settings) : undefined;
  }
  async set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings> {
    // jsonb 병합(||)으로 원자적 upsert — 다른 설정 키를 덮어쓰지 않는다.
    const r = await this.client.query<{ settings: unknown }>(
      `INSERT INTO assay_workspace_settings (workspace, settings, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (workspace) DO UPDATE SET settings = assay_workspace_settings.settings || $2::jsonb, updated_at = now()
       RETURNING settings`,
      [workspace, JSON.stringify(patch)],
    );
    return WorkspaceSettingsSchema.parse(r.rows[0]?.settings ?? patch);
  }
}
