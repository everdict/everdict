import { type RuntimeSpec, RuntimeSpecSchema } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { RuntimeListEntry, RuntimeRegistry } from "./runtime-registry.js";

// Postgres-backed tenant-owned Runtime SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0009_create_runtimes (+ 0047 tags) — runtime column, tags but no created_by/deleted_at.
// Delegates to the shared PgVersionedStore and exposes the runtime surface (has + list-with-tags + tags; no createdBy/softDelete).
export class PgRuntimeRegistry implements RuntimeRegistry {
  private readonly store: PgVersionedStore<RuntimeSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_runtimes",
      column: "runtime",
      label: "runtime",
      parse: (v) => RuntimeSpecSchema.parse(v),
      tags: true,
    });
  }

  register(tenant: string, spec: RuntimeSpec): Promise<void> {
    return this.store.register(tenant, spec);
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
  get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec> {
    return this.store.get(tenant, id, ref);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // RuntimeListEntry = version summary + version tags only (no spec derivations). Built per-id from listIds + versionTags.
  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const out: RuntimeListEntry[] = [];
    for (const { id, owner, versions } of await this.store.listIds(tenant)) {
      const versionTags = await this.store.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions,
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }
}
