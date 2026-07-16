import type { ModelSpec } from "@everdict/contracts";

// Model version SSOT — (tenant, id, version) → ModelSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as harnesses/judges: tenant-owned first, else SHARED_TENANT (first-party default model) fallback.
// A user registers and version-manages their own model (provider+model+baseUrl) directly. async — Postgres honors the same contract.
export interface ModelRegistry {
  // createdBy: subject that registered this version (for soft-delete authz — the creator themselves). No system seed / file loader / bundle apply (undefined).
  register(tenant: string, spec: ModelSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<ModelSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback, deleted versions excluded
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks), deleted versions excluded
  // createdBy = creator of the first-registered version (for who-may-delete gating; undefined for seed/_shared).
  list(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string; createdBy?: string }>>;
  // Creator subject of a live version this tenant directly owns (undefined if none). Missing/deleted/non-owned version → NotFound — no fallback.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Soft delete (tombstone) — preserve the data but exclude it from reads (keeps reproducibility). Tenant directly-owned only; missing/already-deleted version → NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
}
