import type { BenchmarkAdapterSpec } from "@everdict/datasets";
import { VersionedStore } from "../versioned-store.js";

// Benchmark definition (recipe) SSOT — (tenant, id, version) → BenchmarkAdapterSpec (data). Versions are immutable.
// Same ownership model as dataset/harness/judge: tenant-owned first, else _shared (first-party) fallback.
// This is the core of the "per-user/per-tenant benchmark" generalization — turning the catalog (code) into data a tenant registers.
export interface BenchmarkRegistry {
  register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void>;
  get(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // this tenant's owned only (conflict check)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

// Delegates to the shared VersionedStore and exposes only the benchmark surface (no has/softDelete/createdBy/tags — a
// benchmark recipe is a plain immutable version). ownerOf here is has-live-version (VersionedStore's model), whereas the
// former hand-rolled impl keyed on id-existence; equivalent because benchmarks have no tombstones (no softDelete → no
// deleted versions can exist), so "has a live version" and "the id exists" coincide.
export class InMemoryBenchmarkRegistry implements BenchmarkRegistry {
  private readonly store = new VersionedStore<BenchmarkAdapterSpec>("Benchmark");

  async register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void> {
    this.store.register(tenant, spec);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async get(tenant: string, id: string, ref?: string): Promise<BenchmarkAdapterSpec> {
    return this.store.get(tenant, id, ref);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
