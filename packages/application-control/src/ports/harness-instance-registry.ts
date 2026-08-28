import type { CapabilityOrigin, HarnessInstanceSpec, HarnessSpec, ServiceHarnessSpec } from "@everdict/contracts";

// List metadata — live-version summary for one id (from registration history). Spec derivations like category/kind are filled in by the upstream registry.
export interface VersionMeta {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  // 소유 팀 — 목록이 팀으로 걸리려면 행에 실려야 한다. 최신 버전 기준(소유권은 릴리스가 아니라 대상
  // 자체에 붙는다). 없음 = 소유자 없음(_shared/시드).
  teamId?: string;
  createdBy?: string; // subject of the first registered version
  latestCreatedBy?: string; // subject of the latest (semver) version — the privacy owner for a user-secret harness (visibility follows the version that decides privacy)
  createdAt?: string; // first registration time (ISO)
  updatedAt?: string; // most recent registration time (ISO)
  versionTags?: Record<string, string[]>; // version → tags (empty versions omitted; if no tags at all, the field itself is omitted)
  // version → where that version came from (only versions that were stamped; if none was, the field is omitted).
  // Per-VERSION, not per-id: v1 born from an issue and v2 shaped in a later conversation are different answers to
  // "why does this exist", and collapsing them to the first would make the newest version the least explained one.
  versionOrigins?: Record<string, CapabilityOrigin>;
}

// One list entry — version meta (registration history) + display fields derived from the latest instance (category/kind/subtitle).
// GET /harnesses and MCP list_harnesses produce this shape. Same grain as the dataset DatasetListEntry.
export interface HarnessListEntry extends VersionMeta {
  category?: string; // template category of the latest instance (cli-agent, etc.)
  // The shape (template) the latest instance rides on. Two harnesses that differ only by env/pins are siblings on
  // ONE template — without this the list cannot say so, and every variation reads as an unrelated harness.
  templateId?: string;
  templateVersion?: string;
  // What the latest instance changes relative to that shape (`summarizeInstanceVariation`) — the display answer to
  // "which of these is this one?" when several harnesses share a template. Derived, never authored, so it cannot
  // drift from what the resolver applies. Absent when the instance is the template unchanged.
  variation?: { scope?: string; label: string }[];
  kind?: string; // command | service | process (resolved)
  subtitle?: string; // model/command/service summary (a harness has no free-text description, so this serves as the subtitle)
  // true if the latest instance references a user-scoped secret — this harness is visible to createdBy only (private).
  // The API uses this value + createdBy to hide it from other users in list/detail (the value itself is derived — not stored separately).
  private?: boolean;
}

// Individual harness (instance) registry — (tenant, id, version) → HarnessInstanceSpec (template reference + pins).
// get()/getService() pin the template and return a resolved HarnessSpec (drop-in compatible with the existing HarnessRegistry.get).
// Instances stack as versions under the same id (= template.id) → list groups them by category (template).
export interface HarnessInstanceRegistry {
  register(
    tenant: string,
    instance: HarnessInstanceSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  // See `AgentRegistry.registerPreservingOwner` — the same window, closed the same way (arch-review 77), and
  // the same `authority` precondition for the AUTHORIZER's window plus the `_shared`-only initial owner
  // (arch-review 115). One shape, two registries: a lane that carried the guarantee and a lane that did not
  // is how this axis has come apart every time.
  registerPreservingOwner(
    tenant: string,
    instance: HarnessInstanceSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
    authority?: { expectedOwnerTeamId?: string; initialTeamId?: string },
  ): Promise<"registered" | "owner_moved">;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>; // resolved (template + pins)
  // resolved + submit-time transient pins (registry unchanged) — when a CI PR trigger swaps just one service image to evaluate.
  resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec>;
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  // Only the versions this tenant registered DIRECTLY (no `_shared` fallback) — the question "is this the
  // workspace's own harness, and whose is it here" that the private-team read ceiling and the ownership
  // transfer both stand on.
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<HarnessListEntry[]>;
  // The first-registrant subject of this harness id (no seed/shared) — for verifying the owner of a private (references a personal secret) harness.
  creatorOf(tenant: string, id: string): Promise<string | undefined>;
  // The registrant subject of this "version" — for delete authz (creator-or-admin). Non-owned/deleted/absent → NotFound (same as datasets).
  // The team that owns this version — the authz kernel's team-axis input. Undefined = unowned
  // (`_shared`/seeded), which the gate lets through; it is NOT "everyone's". REQUIRED, no longer optional
  // (review wave C): the re-pin preserves the base's team through it — a successor registered without its
  // base's team moved the whole entity out of that team's list the moment it became latest, and the
  // optional shape is exactly how that read stayed unwired.
  teamOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Ownership transfer — the ENTITY moves, so every version of it moves (see VersionedStore.moveToTeam). A
  // transfer mints no version: ownership is metadata beside createdBy, outside the immutable spec. Tenant
  // directly-owned live entities only → NotFound otherwise; authorization lives in the caller.
  moveToTeam(tenant: string, id: string, teamId: string): Promise<void>;

  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Version soft-delete (tombstone) — data is preserved (past scorecard reproducibility), excluded from every read, re-registering identical content revives it.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form labels, full replacement) — mutable registry meta (outside spec immutability). Tenant-owned live versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions with tags). Reads resolve owner like versions() (including _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
  // version → registration instant (ISO, live versions only). Owner resolution matches versions() (incl. the
  // _shared fallback). The product timeline reads it to place capability-version events on the axis.
  // Optional (the fake-heavy test surface predates it): a registry without it simply has no capability
  // timeline — the caller treats absence as an empty map.
  versionDates?(tenant: string, id: string): Promise<Record<string, string>>;
}
