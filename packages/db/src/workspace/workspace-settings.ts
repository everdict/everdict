import { type WorkspaceSettings, WorkspaceSettingsSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

import type { WorkspaceSettingsStore } from "@everdict/application-control";

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
      "SELECT settings FROM everdict_workspace_settings WHERE workspace = $1",
      [workspace],
    );
    return r.rows[0] ? WorkspaceSettingsSchema.parse(r.rows[0].settings) : undefined;
  }
  async set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings> {
    // Atomic upsert via jsonb merge (||) — does not overwrite other settings keys.
    const r = await this.client.query<{ settings: unknown }>(
      `INSERT INTO everdict_workspace_settings (workspace, settings, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (workspace) DO UPDATE SET settings = everdict_workspace_settings.settings || $2::jsonb, updated_at = now()
       RETURNING settings`,
      [workspace, JSON.stringify(patch)],
    );
    return WorkspaceSettingsSchema.parse(r.rows[0]?.settings ?? patch);
  }
}
