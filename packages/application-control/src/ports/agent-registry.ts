import type { AgentSpec, CapabilityOrigin } from "@everdict/contracts";

// Agent version SSOT — (tenant, id, version) → AgentSpec. Versions are immutable. "latest" is the semver/registration-order
// latest. Same ownership model as models/judges: tenant-owned first, else SHARED_TENANT (first-party default agent)
// fallback. A workspace registers and version-manages its own agent (instructions + MCP tool servers + model) directly.
// async — Postgres honors the same contract.
export interface AgentRegistry {
  // createdBy: subject that registered this version (for soft-delete authz — the creator themselves). No seed/file/bundle (undefined).
  register(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void>;
  // Register a SUCCESSOR under whatever team owns the entity right now, resolved where the write happens.
  // The read-then-write spelling (`teamOfEntity` then `register(..., teamId)`) has a window an ownership
  // transfer fits through, and detecting that afterwards is write-then-verify (arch-review 77).
  // ── THE OWNER THE CALLER WAS AUTHORIZED AGAINST, AND THE ONE A NEW ENTITY GETS ───────────────────
  //
  // arch-review 77 closed the window inside the WRITER: the team is resolved where the write happens instead
  // of being read and carried. That is right, and the AUTHORIZER still has the same window — the route reads
  // `teamOfEntity` to gate, the store re-reads it to write, and a transfer between them lands the successor
  // under a team the caller may not write to at all (arch-review 115).
  //
  //     the current owner was preserved   ≠   the caller was authorized against that current owner
  //
  // So the authorization travels as a PRECONDITION, asserted in the same statement that resolves the current
  // owner. `expectedOwnerTeamId` is what the gate saw — `undefined` meaning it authorized an UNOWNED entity,
  // which is a claim like any other. A mismatch answers `owner_moved`; nothing is written.
  //
  // `initialTeamId` covers the other half: `ownerOf` falls back to `_shared` while the owner lookup is
  // tenant-local, so a candidate that exists only in `_shared` has no local owner and the successor was born
  // UNOWNED — a private team's campaign minting a capability visible to every other team. Where there is no
  // local owner to preserve, the authority that caused the write is the initial one.
  //
  // Omitting `authority` keeps the pre-115 behaviour exactly, for the lanes (agent bump, harness re-pin) whose
  // caller authorized the entity itself rather than a separate campaign; those can only ever get `registered`.
  registerPreservingOwner(
    tenant: string,
    spec: AgentSpec,
    createdBy?: string,
    origin?: CapabilityOrigin,
    authority?: { expectedOwnerTeamId?: string; initialTeamId?: string },
  ): Promise<"registered" | "owner_moved">;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<AgentSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback, deleted versions excluded
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks), deleted excluded
  // createdBy = creator of the first-registered version (for who-may-delete gating; undefined for seed/_shared).
  // `teamId` = the owning team (mig 0106) — absent means unowned (a `_shared`/seeded entry, or one from
  // before the axis), which is the workspace's. Surfaced because the read applies the visible-team ceiling.
  // `versionOrigins` = version → birth stamp (only stamped versions; omitted when none) — the same
  // per-version answer every other registry list carries, and what the succeeds/born_from harvest reads.
  list(tenant: string): Promise<
    Array<{
      id: string;
      versions: string[];
      owner: string;
      teamId?: string;
      createdBy?: string;
      versionOrigins?: Record<string, CapabilityOrigin>;
    }>
  >;
  // Creator subject of a live version this tenant directly owns (undefined if none). Missing/deleted/non-owned version → NotFound — no fallback.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Soft delete (tombstone) — preserve the data but exclude it from reads. Tenant directly-owned only; missing/already-deleted version → NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
}
