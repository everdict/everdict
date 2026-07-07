import { ConflictError, type ModelSpec, NotFoundError } from "@everdict/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// Model version SSOT — (tenant, id, version) → ModelSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as harnesses/judges: tenant-owned first, else SHARED_TENANT (first-party default model) fallback.
// A user registers and version-manages their own model (provider+model+baseUrl) directly. async — Postgres honors the same contract.
export interface ModelRegistry {
  register(tenant: string, spec: ModelSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<ModelSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

interface Entry {
  spec: ModelSpec;
  seq: number;
}

export class InMemoryModelRegistry implements ModelRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
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

  async register(tenant: string, spec: ModelSpec): Promise<void> {
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
          `model ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
        );
      }
      return;
    }
    versions.set(spec.version, { spec, seq: this.seq++ });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? (this.byOwner.get(owner)?.get(id)?.has(version) ?? false) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // exactly this tenant's own (no fallback)
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<ModelSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `model '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const ids = new Map<string, string>(); // id → owner (tenant first)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }
}
