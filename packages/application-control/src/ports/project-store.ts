import type { ProjectRecord, ProjectStatus, ProjectUpdateRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface ProjectListFilter {
  status?: ProjectStatus;
  // Membership tests against the project's own lists (`initiativeIds` / `teamIds`) — both are many-to-many, so
  // "this initiative's projects" and "this team's projects" are containment questions the store answers, not
  // joins the service has to assemble.
  initiativeId?: string;
  teamId?: string;
  // "Any of these initiatives" — one query for an initiative AND its descendants, so a nested readiness roll-up
  // is a single read instead of one per node in the tree.
  initiativeIds?: string[];
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

// The posted updates of a project — append-only, newest first. A sub-resource of the project, so it lives in
// its owner's port file rather than growing a domain of its own.
export interface ProjectUpdateStore {
  create(record: ProjectUpdateRecord): Promise<void>;
  list(tenant: string, projectId: string, limit?: number): Promise<ProjectUpdateRecord[]>;
}
