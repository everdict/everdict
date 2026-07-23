import type { AgentSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port lives in @everdict/application-control; this InMemory impl `implements` it, so the registry
// re-exports the port here beside the impl as a deliberate convenience (a consumer imports both together).
export type { AgentRegistry } from "@everdict/application-control";
import type { AgentRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore and exposes the agent surface (has + createdBy/softDelete; no version tags).
// Agents have tombstones (softDelete), so ownerOf's has-live-version semantics matter — an all-tombstoned id disappears
// from reads, exactly as the shared store implements.
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly store = new VersionedStore<AgentSpec>("agent");

  async register(tenant: string, spec: AgentSpec, createdBy?: string): Promise<void> {
    this.store.register(tenant, spec, createdBy);
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
  async get(tenant: string, id: string, ref?: string): Promise<AgentSpec> {
    return this.store.get(tenant, id, ref);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; createdBy?: string }>> {
    return this.store.listMeta(tenant).map((m) => ({
      id: m.id,
      versions: m.versions,
      owner: m.owner,
      ...(m.createdBy !== undefined ? { createdBy: m.createdBy } : {}),
    }));
  }
  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.store.softDelete(tenant, id, version);
  }
}
