import type { CapabilityName, CapabilityOrigin, RuntimeSpec } from "@everdict/contracts";

// Runtime (execution infra) version SSOT — (tenant, id, version) → RuntimeSpec. Versions are immutable. "latest" = newest by semver/registration order.
// Same ownership model as harness/dataset/judge: tenant-owned first, else SHARED_TENANT (first-party shared runtime) fallback.
// A tenant registers and version-manages its own execution infra (local/nomad/k8s) directly. async — Postgres honors the same contract.
// One list() entry — version summary + version tags (only versions that have tags).
export interface RuntimeListEntry {
  id: string;
  versions: string[];
  owner: string;
  // The owning team (mig 0106) — absent = unowned (a `_shared`/seeded runtime), which is the workspace's.
  teamId?: string;
  versionTags?: Record<string, string[]>; // version → free-form label — mutable registry metadata (outside the spec)
  // version → where that version came from (only stamped versions; omitted entirely when none was).
  versionOrigins?: Record<string, CapabilityOrigin>;
  // The latest version's declared capabilities — surfaced so a submit-time picker can preview runtime↔harness fit
  // (a service harness needs `docker`, etc.) before dispatch. Absent = the runtime declares none (treated unchecked).
  capabilities?: CapabilityName[];
}

export interface RuntimeRegistry {
  register(
    tenant: string,
    spec: RuntimeSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  // The owning team — the value the authz kernel's team axis reads (undefined = unowned).
  // ── REQUIRED, BECAUSE EVERY IMPLEMENTATION HAS IT (arch-review 119) ────────────────────────────
  //
  // Declared optional, this is the permissive arm of an authorization read: `registry.teamOfVersion?.(…)`
  // answers `undefined` for a registry that does not implement it, which every gate reads as "unowned" and
  // lets through. Twenty implementations exist and not one is missing it, so the optionality bought nothing
  // and cost the ability to write a gate that cannot be skipped (rule `protocol`).
  teamOfVersion(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
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
