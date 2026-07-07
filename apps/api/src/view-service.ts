import { ForbiddenError, NotFoundError } from "@everdict/core";
import type { ViewRecord, ViewStore, ViewVisibility } from "@everdict/db";

// Saved scorecard-analysis View CRUD. Workspace (tenant) scoped. Read = shared views + my private ones; edit/delete = owner or admin.
// config is the web AnalysisConfig (opaque) — the control plane does not enforce its shape. Design: docs/architecture/scorecard-analysis-views.md.
export interface CreateViewInput {
  tenant: string;
  createdBy: string;
  name: string;
  config: unknown;
  visibility?: ViewVisibility; // defaults to "private"
}

export interface UpdateViewInput {
  name?: string;
  config?: unknown;
  visibility?: ViewVisibility;
}

export interface ViewServiceDeps {
  store: ViewStore;
  newId?: () => string;
  now?: () => string;
}

export class ViewService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ViewServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateViewInput): Promise<ViewRecord> {
    const ts = this.now();
    const record: ViewRecord = {
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      config: input.config,
      visibility: input.visibility ?? "private",
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.create(record);
    return record;
  }

  // Views I can see (shared + my private).
  list(tenant: string, subject: string): Promise<ViewRecord[]> {
    return this.deps.store.listVisible(tenant, subject);
  }

  // Single view — private is owner-only, shared is anyone in the workspace. Otherwise 404 (no existence leak).
  async get(tenant: string, id: string, subject: string): Promise<ViewRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record || (record.visibility === "private" && record.createdBy !== subject))
      throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' not found.`);
    return record;
  }

  async update(
    tenant: string,
    id: string,
    patch: UpdateViewInput,
    actor: { subject: string; isAdmin: boolean },
  ): Promise<ViewRecord> {
    const existing = await this.getRecord(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "views:edit" },
        "You are not allowed to edit this View (owner or workspace admin only).",
      );
    const updated = await this.deps.store.update(tenant, id, { ...patch, updatedAt: this.now() });
    if (!updated) throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' not found.`);
    return updated;
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.getRecord(tenant, id);
    if (existing.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "views:delete" },
        "You are not allowed to delete this View (owner or workspace admin only).",
      );
    await this.deps.store.remove(tenant, id);
  }

  // Internal single fetch (visibility-agnostic) — for ownership checks / edit / delete.
  private async getRecord(tenant: string, id: string): Promise<ViewRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `view '${id}' not found.`);
    return record;
  }
}
