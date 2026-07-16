import { type ModelSpec, ModelSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { ModelRegistry } from "./model-registry.js";

// Postgres-backed tenant-owned model SSOT. (tenant, id, version) key. Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0013_create_models (+ 0056 created_by/deleted_at). No version tags column.
// Delegates to the shared PgVersionedStore and exposes the model surface (has + createdBy/softDelete; no tags).
export class PgModelRegistry implements ModelRegistry {
  private readonly store: PgVersionedStore<ModelSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_models",
      column: "model",
      label: "model",
      parse: (v) => ModelSpecSchema.parse(v),
      softDelete: true,
      createdBy: true,
    });
  }

  register(tenant: string, spec: ModelSpec, createdBy?: string): Promise<void> {
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
  get(tenant: string, id: string, ref?: string): Promise<ModelSpec> {
    return this.store.get(tenant, id, ref);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; createdBy?: string }>> {
    // listMeta carries the first-registered creator (createdBy) alongside the id/versions/owner summary the model list needs.
    return (await this.store.listMeta(tenant)).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.createdBy !== undefined ? { createdBy: m.createdBy } : {}),
    }));
  }
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  softDelete(tenant: string, id: string, version: string): Promise<void> {
    return this.store.softDelete(tenant, id, version);
  }
}
