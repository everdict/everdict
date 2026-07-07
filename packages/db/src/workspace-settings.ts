import { JudgeRunConfigSchema } from "@assay/core";
import { z } from "zod";
import type { SqlClient } from "./client.js";

// CI repo link — repository ↔ 하니스 서비스 슬롯 매핑 + GitHub Actions OIDC trust policy 를 겸하는 한 레코드.
// link 의 "존재"가 그 레포의 GitHub OIDC 토큰을 이 워크스페이스로 신뢰한다(별도 정책 화면 없음 — zero-input).
// 발사 시점 인증은 레포 기반 페더레이션이라 개인 토큰 불사용 → creator-left 문제 없음(createdBy 는 감사용).
// 설계: docs/architecture/github-actions-trigger.md (D3).
export const WorkspaceCiLinkSchema = z.object({
  repository: z.string().min(1), // "owner/name" (대소문자 무시 비교)
  host: z.string().optional(), // GHE 베이스 URL(예: "https://ghe.acme.io") — 미지정 = github.com. link 키 = (host, repository).
  harness: z.string().min(1), // 하니스 인스턴스 id
  dataset: z.string().optional(), // CI 가 발사할 데이터셋 id — setup-PR 워크플로 생성에 사용
  // 서비스 슬롯 → 모노레포 path filter(선택). 이 레포의 CI 가 갈아끼우는 슬롯들.
  slots: z.record(z.object({ path: z.string().optional() })).default({}),
  createdBy: z.string(), // 감사용(발사 인증과 무관)
  disabled: z.boolean().optional(),
  // 배치는 항상 셀프호스티드(설계 D6) — 두 필드는 좁히기 오버라이드. 미지정 = runs-on "[self-hosted]" + runtime "self:ws" 풀.
  runsOn: z.string().optional(), // 워크플로 runs-on 값(예: "[self-hosted, assay-<id>]"). github-install 의 러너 라벨.
  runtime: z.string().optional(), // run-eval runtime 입력(예: "self:ws:<id>"). 개인 러너(self…)는 upsert 에서 400.
  // PR 평가 발화 방식 — auto=PR 이벤트 자동만 · comment=PR 코멘트 /evaluate 만(비싼 스위트 온디맨드) · both(기본).
  // push(기본 브랜치 재핀)는 항상 발화. 워크플로 YAML 생성(renderCiWorkflow)에만 쓰인다 — 발화 인증(trust)과 무관.
  trigger: z.enum(["auto", "comment", "both"]).optional(),
});
export type WorkspaceCiLink = z.infer<typeof WorkspaceCiLinkSchema>;

// 워크스페이스 단위 설정(컨트롤플레인 정책). JSONB 로 저장해 추후 확장 용이.
// 요청별 override(POST /runs·/scorecards body.*)가 이보다 우선; 이 값은 env 기본 정책을 덮어쓴다.
export const WorkspaceSettingsSchema = z.object({
  meterUsage: z.boolean().optional(), // 미지정이면 env 정책(ASSAY_METER_TENANTS/ASSAY_METER_USAGE) 폴백
  // inline judge grader(예: WebVoyager 프리셋) 채점에 쓸 기본 모델. 컨트롤플레인이 잡(job.judge)으로 자동 주입.
  // 키는 시크릿(SecretStore)에서 별도 주입, 여기엔 모델/프로바이더만(시크릿 아님). 요청별 override 가 우선.
  judge: JudgeRunConfigSchema.optional(),
  // 워크스페이스 소유 Mattermost 통합 — 사내 Mattermost 를 관리자가 워크스페이스에 1회 등록.
  // 아웃바운드 알림 = bot 토큰(SecretStore name-ref)으로 POST /api/v4/posts. 인바운드(슬래시커맨드/버튼)는 후속(S7/S8).
  // nullable: DELETE 는 null 로 클리어(jsonb 병합 || 은 키 삭제 불가라 null 로 무효화, 읽을 때 undefined 취급).
  // 설계: docs/architecture/workspace-scoped-integrations.md
  mattermost: z
    .object({
      host: z.string().url(), // 사내 Mattermost 베이스 URL
      botTokenSecretName: z.string().min(1), // bot access token 의 SecretStore 키 이름(값 자체는 저장/반환 안 함)
      defaultChannelId: z.string().min(1).optional(), // 완료/회귀 알림 기본 채널
      commandTokenSecretName: z.string().min(1).optional(), // 슬래시커맨드/액션 검증 토큰 이름(S7/S8)
      inboundToken: z.string().optional(), // 인바운드 라우팅 토큰(S7/S8)
    })
    .nullable()
    .optional(),
  // (레거시, 읽기 전용 호환) 단수 이미지 레지스트리 — imageRegistries(복수)로 대체됨. 서비스가 읽을 때
  // imageRegistries 가 없으면 이 값을 name="default" 항목으로 승계하고, 다음 쓰기에서 null 로 청산한다.
  imageRegistry: z
    .object({
      host: z.string().min(1),
      namespace: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      pullSecretName: z.string().min(1).optional(),
      pushSecretName: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
  // 워크스페이스 이미지 레지스트리(BYO, 복수) — 하니스 이미지의 분류 기준 + assay image push 발행 대상.
  // 여러 개를 이름으로 등록하고 push 시 선택한다(분류/pull 인증은 전체를 대상으로 host 매칭).
  // 시크릿은 전부 SecretStore name-ref(값 저장/반환 안 함). 설계: docs/architecture/workspace-image-registry.md
  imageRegistries: z
    .array(
      z.object({
        name: z.string().min(1), // 레지스트리 이름(참조 키 — push 선택/해제가 이 이름을 가리킨다)
        host: z.string().min(1), // 레지스트리 host[:port] — "ghcr.io" · "registry.acme.dev:5000"
        namespace: z.string().min(1).optional(), // host 아래 경로 프리픽스 — "acme" → ghcr.io/acme/<name>:<tag>
        username: z.string().min(1).optional(), // docker login 사용자명(토큰 단독 레지스트리는 생략)
        pullSecretName: z.string().min(1).optional(), // SecretStore 키 — pull 토큰/패스워드
        pushSecretName: z.string().min(1).optional(), // SecretStore 키 — push 토큰/패스워드
      }),
    )
    .optional(),
  // 워크스페이스 트레이스 싱크(복수) — judge 된 스코어카드 상세 결과(trace+점수)를 팀 관측 플랫폼으로 적재(아웃바운드).
  // TraceSource(인바운드 pull)의 거울. 여러 개를 이름으로 등록하고 '하니스별로' 골라 쓴다(워크스페이스 단일 아님).
  // 시크릿은 SecretStore name-ref(값 저장/반환 안 함). 설계: docs/architecture/trace-sink.md
  traceSinks: z
    .array(
      z.object({
        name: z.string().min(1), // 싱크 이름(참조 키 — 하니스 선택이 이 이름을 가리킨다)
        kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(), // 플랫폼 API 베이스 URL
        authSecretName: z.string().min(1).optional(), // SecretStore 키 — 인증 헤더 '값'(무인증 dev 서버는 생략)
        project: z.string().min(1).optional(), // kind별 의미: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId(링크)
        webUrl: z.string().url().optional(), // UI 딥링크 베이스(API endpoint 와 다를 때 — 예: LangSmith api vs smith)
      }),
    )
    .optional(),
  // 하니스별 싱크 선택(harness id → 싱크 이름). 선택 없는 하니스는 적재하지 않는다(옵트인).
  // nullable 값: 선택 해제는 키 삭제 대신 jsonb 병합 특성상 새 맵으로 통째 교체한다(서비스가 관리).
  traceSinkByHarness: z.record(z.string()).optional(),
  // CI 통합(GitHub Actions) — repo link 목록(레포↔하니스 슬롯 매핑 = OIDC trust policy). 위 WorkspaceCiLinkSchema 참고.
  ci: z.object({ links: z.array(WorkspaceCiLinkSchema).default([]) }).optional(),
  // 워크스페이스 소유 GitHub App 통합(개인 연결 대체) — 조직 설치→선택 repo→워크스페이스 소유 installation.
  // github.com App = operator env(GITHUB_APP_*); GHE App = 관리자가 host+App자격증명 등록(private key=SecretStore name-ref).
  // installation 은 단기 토큰을 App 개인키로 온디맨드 발급하므로 여기엔 비밀 없음 — 전부 반환 안전(host/appId/installationId).
  // 설계: docs/architecture/workspace-scoped-integrations.md
  githubApp: z
    .object({
      // GHE App 등록(github.com 은 env → 여기 없음). 관리자가 워크스페이스별 1회 등록.
      registrations: z
        .array(
          z.object({
            host: z.string().url(), // GHE 베이스 URL
            slug: z.string().min(1), // App slug(설치 URL /github-apps/{slug}/installations/new 에 사용)
            appId: z.string().min(1),
            privateKeySecretName: z.string().min(1), // SecretStore 키 — PEM 값 자체는 저장/반환 안 함
          }),
        )
        .default([]),
      // 워크스페이스 소유 installation(github.com + GHE). 설치된 org 당 1건.
      installations: z
        .array(
          z.object({
            host: z.string().url().optional(), // 미지정 = github.com
            installationId: z.number().int(),
            account: z.string().min(1), // 설치된 org/user login
            connectedBy: z.string(), // 감사용 — 링크한 관리자 subject
            connectedAt: z.string(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
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
