import type { RuntimeSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The port + its list-entry type now live in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";
import type { RuntimeListEntry, RuntimeRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore and exposes only the runtime surface (has + list-with-tags + tags; no createdBy/softDelete).
// ownerOf is has-live-version (VersionedStore's model) — equivalent to the former id-existence check because runtimes have
// no tombstones (no softDelete → no deleted versions can exist).
export class InMemoryRuntimeRegistry implements RuntimeRegistry {
  private readonly store = new VersionedStore<RuntimeSpec>("runtime");

  async register(tenant: string, spec: RuntimeSpec): Promise<void> {
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
  async get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec> {
    return this.store.get(tenant, id, ref);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  // RuntimeListEntry = version summary + version tags only (no spec derivations). Built per-id from listIds + versionTags.
  async list(tenant: string): Promise<RuntimeListEntry[]> {
    const out: RuntimeListEntry[] = [];
    for (const { id, owner, versions } of this.store.listIds(tenant)) {
      const versionTags = this.store.versionTags(owner, id);
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
