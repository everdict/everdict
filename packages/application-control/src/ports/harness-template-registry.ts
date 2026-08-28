import type { CapabilityOrigin, HarnessTemplateSpec } from "@everdict/contracts";

// One shape in the catalog — version meta + what the latest version IS. A shape with no harness on it yet is
// reachable only through this list (no instance carries it), so the list has to say what it is on its own.
export interface HarnessTemplateListEntry {
  id: string;
  versions: string[];
  owner: string;
  teamId?: string;
  latestVersion?: string;
  kind?: string; // command | service | process
  category?: string;
  serviceCount?: number; // service shapes only — how many services the topology stands up
}

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
  // The team that owns this version — the authz kernel's team-axis input. Undefined = unowned (`_shared`/seeded).
  // ── REQUIRED, BECAUSE EVERY IMPLEMENTATION HAS IT (arch-review 119) ────────────────────────────
  //
  // Declared optional, this is the permissive arm of an authorization read: `registry.teamOfVersion?.(…)`
  // answers `undefined` for a registry that does not implement it, which every gate reads as "unowned" and
  // lets through. Twenty implementations exist and not one is missing it, so the optionality bought nothing
  // and cost the ability to write a gate that cannot be skipped (rule `protocol`).
  teamOfVersion(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
  // Ownership transfer — the ENTITY moves, so every version of it moves (see VersionedStore.moveToTeam). A
  // transfer mints no version: ownership is metadata beside createdBy, outside the immutable spec. Tenant
  // directly-owned live entities only → NotFound otherwise; authorization lives in the caller.
  moveToTeam(tenant: string, id: string, teamId: string): Promise<void>;
  // `teamId` = the owning team (mig 0106) — absent means unowned (a `_shared`/seeded entry, or one from
  // before the axis), which is the workspace's. Surfaced because the read applies the visible-team ceiling.
  list(tenant: string): Promise<HarnessTemplateListEntry[]>;
}
