import { JudgeRunConfigSchema } from "@assay/core";
import { z } from "zod";
import type { SqlClient } from "./client.js";

// 워크스페이스 단위 설정(컨트롤플레인 정책). JSONB 로 저장해 추후 확장 용이.
// 요청별 override(POST /runs·/scorecards body.*)가 이보다 우선; 이 값은 env 기본 정책을 덮어쓴다.
export const WorkspaceSettingsSchema = z.object({
  meterUsage: z.boolean().optional(), // 미지정이면 env 정책(ASSAY_METER_TENANTS/ASSAY_METER_USAGE) 폴백
  // inline judge grader(예: WebVoyager 프리셋) 채점에 쓸 기본 모델. 컨트롤플레인이 잡(job.judge)으로 자동 주입.
  // 키는 시크릿(SecretStore)에서 별도 주입, 여기엔 모델/프로바이더만(시크릿 아님). 요청별 override 가 우선.
  judge: JudgeRunConfigSchema.optional(),
  // run/scorecard 완료 알림 대상 — 워크스페이스의 Mattermost 외부 계정 연결(connectionId) + 채널(channelId).
  // 컨트롤플레인이 완료 시 그 연결 토큰으로 채널에 게시. 미설정이면 알림 없음(토큰/채널 값은 저장 안 함 — id 참조만).
  notify: z.object({ connectionId: z.string(), channelId: z.string() }).optional(),
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
