import type { ViewRecord } from "@everdict/contracts";

// Workspace (tenant) scoped. listVisible = my private + workspace-shared (others' private are not visible).
export interface ViewStore {
  create(record: ViewRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ViewRecord | undefined>;
  listVisible(tenant: string, subject: string): Promise<ViewRecord[]>;
  update(tenant: string, id: string, patch: Partial<ViewRecord>): Promise<ViewRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
