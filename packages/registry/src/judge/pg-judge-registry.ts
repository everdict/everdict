import { type JudgeSpec, JudgeSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import { type JudgeListEntry, type JudgeRegistry, judgeDerived } from "./judge-registry.js";

// Postgres-backed tenant-owned judge SSOT. (tenant, id, version) key. Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0008_create_judges (+ 0032 created_by, 0047 tags) — judge column, created_by + tags, no deleted_at.
// Delegates to the shared PgVersionedStore and exposes the judge surface (has/ownVersions/rich list/createdBy/tags; NO softDelete).
export class PgJudgeRegistry implements JudgeRegistry {
  private readonly store: PgVersionedStore<JudgeSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_judges",
      column: "judge",
      label: "judge",
      parse: (v) => JudgeSpecSchema.parse(v),
      createdBy: true,
      tags: true,
    });
  }

  register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void> {
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
  get(tenant: string, id: string, ref?: string): Promise<JudgeSpec> {
    return this.store.get(tenant, id, ref);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // JudgeListEntry = shared version meta + judgeDerived over the latest spec (the per-entity display fields).
  async list(tenant: string): Promise<JudgeListEntry[]> {
    const out: JudgeListEntry[] = [];
    for (const meta of await this.store.listMeta(tenant)) {
      const latestSpec = await this.store.get(meta.owner, meta.id, meta.latestVersion);
      out.push({
        id: meta.id,
        owner: meta.owner,
        versions: meta.versions,
        latestVersion: meta.latestVersion,
        versionCount: meta.versionCount,
        ...judgeDerived(latestSpec),
        ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.versionTags !== undefined ? { versionTags: meta.versionTags } : {}),
      });
    }
    return out;
  }
}
