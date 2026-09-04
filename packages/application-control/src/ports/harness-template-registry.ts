import type { CapabilityOrigin, HarnessTemplateSpec } from "@everdict/contracts";

// One shape in the catalog — version meta + what the latest version IS. A shape with no harness on it yet is
// reachable only through this list (no instance carries it), so the list has to say what it is on its own.
export interface HarnessTemplateListEntry {
  id: string;
  versions: string[];
  owner: string;
  latestVersion?: string;
  kind?: string; // command | service | process
  category?: string;
  serviceCount?: number; // service shapes only — how many services the topology stands up
}

// Harness template (category) version SSOT — (tenant, id, version) → HarnessTemplateSpec. Versions immutable, _shared fallback.
// Holds structure only (services/dependencies/slots) (versions not pinned). Instances are made by HarnessInstanceRegistry pinning this template.
export interface HarnessTemplateRegistry {
  register(tenant: string, spec: HarnessTemplateSpec, createdBy?: string, origin?: CapabilityOrigin): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessTemplateSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  // before the axis), which is the workspace's.
  list(tenant: string): Promise<HarnessTemplateListEntry[]>;
}
