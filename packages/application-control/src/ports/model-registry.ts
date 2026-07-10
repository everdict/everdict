import type { ModelSpec } from "@everdict/contracts";

// Model version SSOT — (tenant, id, version) → ModelSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as harnesses/judges: tenant-owned first, else SHARED_TENANT (first-party default model) fallback.
// A user registers and version-manages their own model (provider+model+baseUrl) directly. async — Postgres honors the same contract.
export interface ModelRegistry {
  register(tenant: string, spec: ModelSpec): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<ModelSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>>;
}
