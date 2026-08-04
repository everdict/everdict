import type { CapabilityOrigin, HarnessTemplateSpec } from "@everdict/contracts";

// Harness template (category) version SSOT — (tenant, id, version) → HarnessTemplateSpec. Versions immutable, _shared fallback.
// Holds structure only (services/dependencies/slots) (versions not pinned). Instances are made by HarnessInstanceRegistry pinning this template.
export interface HarnessTemplateRegistry {
  register(
    tenant: string,
    spec: HarnessTemplateSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  // `teamId` = the owning team (mig 0106) — absent means unowned (a `_shared`/seeded entry, or one from
  // before the axis), which is the workspace's. Surfaced because the read applies the visible-team ceiling.
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; teamId?: string }>>;
}
