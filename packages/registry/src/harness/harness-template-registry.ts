import type { HarnessTemplateSpec } from "@everdict/contracts";
import { VersionedStore } from "../versioned-store.js";

// The registry port lives in @everdict/application-control; this InMemory impl `implements` it, so the registry
// re-exports the port here beside the impl as a deliberate convenience (a consumer imports both together).
export type { HarnessTemplateRegistry } from "@everdict/application-control";
import type { HarnessTemplateRegistry } from "@everdict/application-control";

export class InMemoryHarnessTemplateRegistry implements HarnessTemplateRegistry {
  private readonly store = new VersionedStore<HarnessTemplateSpec>("template");

  async register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string): Promise<void> {
    this.store.register(tenant, spec, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec> {
    return this.store.get(tenant, id, ref);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    return this.store.listIds(tenant);
  }
}
