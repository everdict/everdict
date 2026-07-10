import type { WorkspaceSettings } from "@everdict/contracts";

export interface WorkspaceSettingsStore {
  get(workspace: string): Promise<WorkspaceSettings | undefined>;
  set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings>; // partial-merge upsert
}
