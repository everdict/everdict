import { ConflictError, NotFoundError, type RuntimeSpec } from "@everdict/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "../registry.js";

// The port + its list-entry type now live in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";
import type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";

interface Entry {
  spec: RuntimeSpec;
  seq: number;
  tags?: string[]; // version tags — mutable registry metadata (outside spec immutability)
}

export class InMemoryRuntimeRegistry implements RuntimeRegistry {
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

  async register(tenant: string, spec: RuntimeSpec): Promise<void> {
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
          `runtime ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
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
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<RuntimeSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `runtime '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const ids = new Map<string, string>();
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    const out: RuntimeListEntry[] = [];
    for (const [id, owner] of [...ids.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const versionTags = await this.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions: this.ownerVersions(owner, id),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version); // direct ownership only (no fallback — _shared can't be tagged)
    if (!entry) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `runtime ${id}@${version} not found.`);
    entry.tags = tags.length > 0 ? tags : undefined; // empty array = removal (same idiom as revive's deletedAt=undefined)
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.tags !== undefined && e.tags.length > 0) out[e.spec.version] = e.tags;
    }
    return out;
  }
}
