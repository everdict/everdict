import type { HarnessTemplateSpec } from "@everdict/core";
import { VersionedStore } from "../versioned-store.js";

// Harness template (category) version SSOT — (tenant, id, version) → HarnessTemplateSpec. Versions immutable, _shared fallback.
// Holds structure only (services/dependencies/slots) (versions not pinned). Instances are made by HarnessInstanceRegistry pinning this template.
export interface HarnessTemplateRegistry {
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}

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
