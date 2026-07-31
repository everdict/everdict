import type { ProjectRecord, ProjectStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface ProjectListFilter {
  status?: ProjectStatus;
  initiativeId?: string;
  limit?: number;
}

export interface ProjectStore {
  create(record: ProjectRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<ProjectRecord | undefined>;
  list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<ProjectRecord>,
    events?: OutboxEvent[],
  ): Promise<ProjectRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
