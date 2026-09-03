import { type CapabilityOrigin, type EnvironmentSpec, EnvironmentSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { EnvironmentListEntry, EnvironmentRegistry } from "./environment-registry.js";

// Postgres-backed tenant-owned Environment SSOT. Key (tenant, id, version). Tenant-owned first, else _shared
// fallback. Schema: @everdict/db/migrations/0207_create_environments (environment column + tags + team_id +
// origin + created_by, all of them from the start). Design: docs/architecture/harness-definability-spec.md §2.
export class PgEnvironmentRegistry implements EnvironmentRegistry {
  private readonly store: PgVersionedStore<EnvironmentSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_environments",
      column: "environment",
      label: "environment",
      parse: (v) => EnvironmentSpecSchema.parse(v),
      tags: true,
      origin: true,
      createdBy: true,
    });
  }

  register(tenant: string, spec: EnvironmentSpec, createdBy?: string, origin?: CapabilityOrigin): Promise<void> {
    return this.store.register(tenant, spec, createdBy, origin);
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
  get(tenant: string, id: string, ref?: string): Promise<EnvironmentSpec> {
    return this.store.get(tenant, id, ref);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<EnvironmentListEntry[]> {
    const out: EnvironmentListEntry[] = [];
    for (const { id, owner, versions } of await this.store.listIds(tenant)) {
      const versionTags = await this.store.versionTags(owner, id);
      const versionOrigins = await this.store.versionOrigins(owner, id);
      out.push({
        id,
        owner,
        versions,
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(Object.keys(versionOrigins).length > 0 ? { versionOrigins } : {}),
      });
    }
    return out;
  }
}
