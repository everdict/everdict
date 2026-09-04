import type { CapabilityOrigin, EnvironmentSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port + its list-entry type live in @everdict/application-control; this InMemory impl `implements`
// the port, so the registry re-exports it here beside the impl (import both together), exactly as the runtime
// registry does. Design: docs/architecture/harness-definability-spec.md §2.
export type { EnvironmentListEntry, EnvironmentRegistry } from "@everdict/application-control";
import type { EnvironmentListEntry, EnvironmentRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore — the same machinery every other versioned registry uses.
export class InMemoryEnvironmentRegistry implements EnvironmentRegistry {
  private readonly store = new VersionedStore<EnvironmentSpec>("environment");

  async register(tenant: string, spec: EnvironmentSpec, createdBy?: string, origin?: CapabilityOrigin): Promise<void> {
    this.store.register(tenant, spec, createdBy, origin);
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
  async get(tenant: string, id: string, ref?: string): Promise<EnvironmentSpec> {
    return this.store.get(tenant, id, ref);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<EnvironmentListEntry[]> {
    const out: EnvironmentListEntry[] = [];
    for (const { id, owner, versions } of this.store.listIds(tenant)) {
      const versionTags = this.store.versionTags(owner, id);
      const versionOrigins = this.store.versionOrigins(owner, id);
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
