import type { HarnessTemplateSpec } from "@everdict/contracts";

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
