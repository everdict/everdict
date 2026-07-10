import { type RubricSpec, RubricSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import { type RubricListEntry, type RubricRegistry, rubricDerived } from "./rubric-registry.js";

// Postgres-backed tenant-owned rubric SSOT. (tenant, id, version) key. Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0053_create_rubrics (+ 0054 tags) — rubric column, created_by + tags, no deleted_at.
// Delegates to the shared PgVersionedStore and exposes the rubric surface (has/ownVersions/rich list/createdBy/tags; NO softDelete).
export class PgRubricRegistry implements RubricRegistry {
  private readonly store: PgVersionedStore<RubricSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_rubrics",
      column: "rubric",
      label: "rubric",
      parse: (v) => RubricSpecSchema.parse(v),
      createdBy: true,
      tags: true,
    });
  }

  register(tenant: string, spec: RubricSpec, createdBy?: string): Promise<void> {
    return this.store.register(tenant, spec, createdBy);
  }
  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  get(tenant: string, id: string, ref?: string): Promise<RubricSpec> {
    return this.store.get(tenant, id, ref);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // RubricListEntry = shared version meta + rubricDerived over the latest spec (the per-entity display fields).
  async list(tenant: string): Promise<RubricListEntry[]> {
    const out: RubricListEntry[] = [];
    for (const meta of await this.store.listMeta(tenant)) {
      const latestSpec = await this.store.get(meta.owner, meta.id, meta.latestVersion);
      out.push({
        id: meta.id,
        owner: meta.owner,
        versions: meta.versions,
        latestVersion: meta.latestVersion,
        versionCount: meta.versionCount,
        ...rubricDerived(latestSpec),
        ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.versionTags !== undefined ? { versionTags: meta.versionTags } : {}),
      });
    }
    return out;
  }
}
