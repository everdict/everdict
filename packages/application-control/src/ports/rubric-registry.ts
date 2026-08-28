import type { CapabilityOrigin, RubricSpec } from "@everdict/contracts";

// One list entry — version metadata (registration history) + display fields derived from the latest rubric spec (description/subtitle).
// GET /rubrics and MCP list_rubrics emit this shape. Same feel as the judge/dataset ListEntry.
export interface RubricListEntry {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  description?: string; // rubric description (spec field)
  subtitle?: string; // content summary (text · N criteria · template) — list subtitle
  createdBy?: string; // subject of the first-registered version (absent for seed/_shared)
  // The owning team (mig 0106) — absent = unowned (a `_shared`/seeded rubric, or one from before the axis), which
  // is the workspace's. Both impls already carried it; the list read needs it to apply the ownership ceiling.
  teamId?: string;
  createdAt?: string;
  updatedAt?: string;
  versionTags?: Record<string, string[]>; // version → free-form label (tagged versions only) — mutable registry metadata (outside the spec)
  // version → where that version came from (only stamped versions; omitted entirely when none was).
  versionOrigins?: Record<string, CapabilityOrigin>;
}

// Rubric version SSOT — (tenant, id, version) → RubricSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as judges/datasets: tenant-owned first, else SHARED_TENANT (first-party default rubric) fallback.
// One rubric serves many judges (JudgeSpec.rubric may reference it as {id, version}). async — Postgres honors the same contract.
export interface RubricRegistry {
  register(
    tenant: string,
    spec: RubricSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  // ── THE OWNING TEAM, WHICH THE PORT NEVER DECLARED (arch-review 119) ──────────────────────────
  //
  // Both implementations answer this and the routes gate on it through `teamOfEntity`'s optional chain — so
  // it worked at runtime while every consumer typed against THIS port could not read ownership at all. A
  // capability the port omits is one no gate can be written against; a rubric's `register` has taken a
  // `teamId` since migration 0106.
  teamOfVersion(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<RubricSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<RubricListEntry[]>;
  // Version tags (free-form labels, full replacement) — mutable registry metadata (outside spec immutability). Tenant-owned versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tag map (tagged versions only). Reads resolve owner like versions() (incl. _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
