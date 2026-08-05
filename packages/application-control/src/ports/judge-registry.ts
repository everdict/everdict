import type { CapabilityOrigin, JudgeSpec } from "@everdict/contracts";

// One list entry — version metadata (registration history) + display fields derived from the latest judge spec (kind/provider/model/description).
// GET /judges and MCP list_judges emit this shape. Same feel as the dataset/harness ListEntry.
export interface JudgeListEntry {
  // 소유 팀 — 목록이 팀으로 걸리려면 행에 실려야 한다(최신 버전 기준). 없음 = 소유자 없음.
  teamId?: string;
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  kind?: string; // model | harness (category role)
  provider?: string; // model judge: anthropic | openai
  model?: string; // model judge: model id
  description?: string; // judge description (spec field)
  subtitle?: string; // provider/model or →harness summary (list subtitle)
  createdBy?: string; // subject of the first-registered version (absent for seed/_shared)
  createdAt?: string;
  updatedAt?: string;
  versionTags?: Record<string, string[]>; // version → free-form label (tagged versions only) — mutable registry metadata (outside the spec)
  // version → where that version came from (only stamped versions; omitted entirely when none was).
  versionOrigins?: Record<string, CapabilityOrigin>;
}

// Agent Judge version SSOT — (tenant, id, version) → JudgeSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as harnesses/datasets: tenant-owned first, else SHARED_TENANT (first-party default judge) fallback.
// A user registers and version-manages their own judge (model/harness) directly. async — Postgres honors the same contract.
export interface JudgeRegistry {
  register(
    tenant: string,
    spec: JudgeSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<JudgeSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<JudgeListEntry[]>;
  // The registrant subject of this "version" — for delete authz (creator-or-admin). Non-owned/deleted/absent → NotFound (same as harnesses/datasets).
  // The team that owns this version — the authz kernel's team-axis input. Undefined = unowned
  // (`_shared`/seeded), which the gate lets through; it is NOT "everyone's".
  teamOfVersion?(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Ownership transfer — the ENTITY moves, so every version of it moves (see VersionedStore.moveToTeam). A
  // transfer mints no version: ownership is metadata beside createdBy, outside the immutable spec. Tenant
  // directly-owned live entities only → NotFound otherwise; authorization lives in the caller.
  moveToTeam(tenant: string, id: string, teamId: string): Promise<void>;

  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Version soft-delete (tombstone) — data is preserved (past scorecard reproducibility), excluded from every read, re-registering identical content revives it.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form labels, full replacement) — mutable registry metadata (outside spec immutability). Tenant-owned versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tag map (tagged versions only). Reads resolve owner like versions() (incl. _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
