import type { AgentSpec, CapabilityOrigin } from "@everdict/contracts";

// Agent version SSOT — (tenant, id, version) → AgentSpec. Versions are immutable. "latest" is the semver/registration-order
// latest. Same ownership model as models/judges: tenant-owned first, else SHARED_TENANT (first-party default agent)
// fallback. A workspace registers and version-manages its own agent (instructions + MCP tool servers + model) directly.
// async — Postgres honors the same contract.
export interface AgentRegistry {
  // createdBy: subject that registered this version (for soft-delete authz — the creator themselves). No seed/file/bundle (undefined).
  register(tenant: string, spec: AgentSpec, createdBy?: string, origin?: CapabilityOrigin): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<AgentSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback, deleted versions excluded
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks), deleted excluded
  // createdBy = creator of the first-registered version (for who-may-delete gating; undefined for seed/_shared).
  // before the axis), which is the workspace's. Surfaced because the read applies the visible-team ceiling.
  // `versionOrigins` = version → birth stamp (only stamped versions; omitted when none) — the same
  // per-version answer every other registry list carries, and what the succeeds/born_from harvest reads.
  list(tenant: string): Promise<
    Array<{
      id: string;
      versions: string[];
      owner: string;
      createdBy?: string;
      versionOrigins?: Record<string, CapabilityOrigin>;
    }>
  >;
  // Creator subject of a live version this tenant directly owns (undefined if none). Missing/deleted/non-owned version → NotFound — no fallback.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Soft delete (tombstone) — preserve the data but exclude it from reads. Tenant directly-owned only; missing/already-deleted version → NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
}
