import type { ModelSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The port now lives in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { ModelRegistry } from "@everdict/application-control";
import type { ModelRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore and exposes only the model surface (has + plain list; no createdBy/tags/softDelete).
// ownerOf is has-live-version (VersionedStore's model) — equivalent to the former id-existence check because models have
// no tombstones (no softDelete → no deleted versions can exist), so the two resolve identically.
export class InMemoryModelRegistry implements ModelRegistry {
  private readonly store = new VersionedStore<ModelSpec>("model");

  async register(tenant: string, spec: ModelSpec): Promise<void> {
    this.store.register(tenant, spec);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async get(tenant: string, id: string, ref?: string): Promise<ModelSpec> {
    return this.store.get(tenant, id, ref);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
