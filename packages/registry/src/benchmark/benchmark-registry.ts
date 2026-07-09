import { ConflictError, NotFoundError } from "@everdict/core";
import type { BenchmarkAdapterSpec } from "@everdict/datasets";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "../registry.js";

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

interface Entry {
  spec: BenchmarkAdapterSpec;
  seq: number;
}

export class InMemoryBenchmarkRegistry implements BenchmarkRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>();
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, spec: BenchmarkAdapterSpec): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(spec.id);
    if (!versions) {
      versions = new Map();
      ids.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      if (!specsEqual(existing.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `Benchmark ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
        );
      }
      return;
    }
    versions.set(spec.version, { spec, seq: this.seq++ });
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<BenchmarkAdapterSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `Benchmark '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const ids = new Map<string, string>();
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }
}
