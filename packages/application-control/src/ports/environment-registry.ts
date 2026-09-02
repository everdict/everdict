import type { CapabilityOrigin, EnvironmentSpec } from "@everdict/contracts";

// ── THE ENVIRONMENT AS AN ENTITY (docs/architecture/harness-definability-spec.md §2) ─────────────────
//
// `(tenant, id, version) → EnvironmentSpec`, the same versioned SSOT shape the harness, dataset, judge and
// runtime registries keep: immutable versions, semver `latest`, tenant-owned with a `_shared` fallback. The
// port lives here and the implementations live in `@everdict/registry`, like every other one.
//
// A case that names its environment by reference (`EnvRefSchema`) is resolved through this registry before
// dispatch, and the version it resolved to is sealed on the batch's manifest — which is what lets one
// dataset be evaluated against two worlds and have the difference read as the ENVIRONMENT axis rather than
// as a change to the harness under test.
export interface EnvironmentListEntry {
  id: string;
  versions: string[];
  owner: string;
  teamId?: string;
  versionTags?: Record<string, string[]>; // version → free-form label — mutable registry metadata (outside the spec)
  versionOrigins?: Record<string, CapabilityOrigin>;
}

export interface EnvironmentRegistry {
  register(
    tenant: string,
    spec: EnvironmentSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  // The adoption lane's write (arch-review 77/115, and the campaign subject of harness-definability-spec §2):
  // the successor keeps the entity's owner, the write asserts the owner the AUTHORIZATION was granted
  // against, and where there is no local owner to preserve the authority that caused the write owns it.
  registerPreservingOwner(
    tenant: string,
    spec: EnvironmentSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
    authority?: { expectedOwnerTeamId?: string; initialTeamId?: string },
  ): Promise<"registered" | "owner_moved">;
  teamOfVersion(tenant: string, id: string, version: string): string | undefined | Promise<string | undefined>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<EnvironmentSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  ownVersions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<EnvironmentListEntry[]>;
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
