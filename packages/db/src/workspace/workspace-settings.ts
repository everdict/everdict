import { type WorkspaceSettings, WorkspaceSettingsSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

import type { WorkspaceSettingsStore } from "@everdict/application-control";

// WHICH SETTINGS ARE PART OF AN EVALUATION CONTRACT (arch-review 24). The revision column exists so a release
// decision that resolved its series contracts under judge J1 cannot commit after the workspace switched to J2
// — an identical judge list judged by a different model is a different judging apparatus.
//
// Bumping it on EVERY settings write made it a workspace-activity counter instead: registering a Mattermost
// channel, toggling usage metering or renaming an image registry would refuse an in-flight ship for a change
// that cannot alter any verdict. A fence that refuses for reasons outside its own subject teaches its callers
// to retry blindly, which is how a fence stops being read as a signal.
//
// Add a key here only when a decision's MEANING depends on it. The test is not "could this matter to
// somebody" — it is "would two evaluations, identical in every other respect, be comparable across a change
// to this key".
const EVALUATION_CONTRACT_KEYS = new Set(["judge"]);

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
    const contractual = Object.keys(patch).some((key) => EVALUATION_CONTRACT_KEYS.has(key)) ? 1 : 0;
    // …and the ROW'S BIRTH is not a change either (arch-review 25 P2). Creating the settings row for a
    // Mattermost channel used to jump the revision from "no row" to 1, which every in-flight ship read as
    // "the judging apparatus moved". A workspace that has never touched an evaluation setting is at revision
    // 0 whether or not a row exists for it — that is the same state, not two.
    const r = await this.client.query<{ settings: unknown }>(
      `INSERT INTO everdict_workspace_settings (workspace, settings, updated_at, revision) VALUES ($1, $2::jsonb, now(), $3::int)
       ON CONFLICT (workspace) DO UPDATE SET settings = everdict_workspace_settings.settings || $2::jsonb, updated_at = now(), revision = everdict_workspace_settings.revision + $3::int
       RETURNING settings`,
      [workspace, JSON.stringify(patch), contractual],
    );
    return WorkspaceSettingsSchema.parse(r.rows[0]?.settings ?? patch);
  }
}
