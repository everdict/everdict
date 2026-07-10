import type { RuntimeSpec } from "@everdict/contracts";

// Runtime (execution infra) version SSOT — (tenant, id, version) → RuntimeSpec. Versions are immutable. "latest" = newest by semver/registration order.
// Same ownership model as harness/dataset/judge: tenant-owned first, else SHARED_TENANT (first-party shared runtime) fallback.
// A tenant registers and version-manages its own execution infra (local/nomad/k8s) directly. async — Postgres honors the same contract.
// One list() entry — version summary + version tags (only versions that have tags).
export interface RuntimeListEntry {
  id: string;
  versions: string[];
  owner: string;
  versionTags?: Record<string, string[]>; // version → free-form label — mutable registry metadata (outside the spec)
}

export interface RuntimeRegistry {
  register(tenant: string, spec: RuntimeSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<RuntimeSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<RuntimeListEntry[]>;
  // Version tags (free-form labels, full replacement) — mutable registry metadata (outside spec immutability). Tenant-owned versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions that have tags). Reads resolve owner like versions() (incl. _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
