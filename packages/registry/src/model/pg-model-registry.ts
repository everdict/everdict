import { type ModelSpec, ModelSpecSchema } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import type { ModelRegistry } from "./model-registry.js";

// Postgres-backed tenant-owned model SSOT. (tenant, id, version) key. Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0013_create_models — plain immutable-version table (model column, no created_by/deleted_at/tags).
// Delegates to the shared PgVersionedStore and exposes only the model surface (has + plain list; no softDelete/createdBy/tags).
export class PgModelRegistry implements ModelRegistry {
  private readonly store: PgVersionedStore<ModelSpec>;
  constructor(client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_models",
      column: "model",
      label: "model",
      parse: (v) => ModelSpecSchema.parse(v),
    });
  }

  register(tenant: string, spec: ModelSpec): Promise<void> {
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
  get(tenant: string, id: string, ref?: string): Promise<ModelSpec> {
    return this.store.get(tenant, id, ref);
  }
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
