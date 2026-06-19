import { z } from "zod";
import type { SqlClient } from "./client.js";

// 워크스페이스 단위 설정(컨트롤플레인 정책). 지금은 사용량 계측 on/off 만 — JSONB 로 저장해 추후 확장 용이.
// 요청별 override(POST /runs body.meterUsage)가 이보다 우선; 이 값은 env 기본 정책을 덮어쓴다.
export const WorkspaceSettingsSchema = z.object({
  meterUsage: z.boolean().optional(), // 미지정이면 env 정책(ASSAY_METER_TENANTS/ASSAY_METER_USAGE) 폴백
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
