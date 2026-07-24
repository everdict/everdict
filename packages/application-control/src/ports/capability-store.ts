import type { CapabilityRecord, CapabilityVisibility } from "@everdict/contracts";

// Persistence port for the Capability Store — one discriminated versioned entity (mcp|code|skill) that members
// author, publish at a reach tier (private|workspace|subset|public), and adopt into their agent. Versioned like the
// registry entities [(tenant,id,version) immutable, soft-delete tombstones] but carrying per-capability VISIBILITY
// metadata instead of the registry's `_shared` fallback. Reads that cross a workspace boundary (subset/public) are
// authorized by `canConsumeCapability` (@everdict/domain) — the Pg impl mirrors those rules in SQL. Impls: InMemory /
// Pg in @everdict/db. See docs/architecture/capability-store.md.
export interface CapabilityStore {
  // Register an immutable version. Idempotent when the content (name/description/spec) is identical; a DIFFERENT
  // content for the same (tenant,id,version) throws ConflictError; a tombstoned version with identical content revives.
  register(record: CapabilityRecord): Promise<void>;

  // Owner-tenant fetch (latest, or an exact version), live versions only. undefined if absent/deleted.
  get(tenant: string, id: string, ref?: string): Promise<CapabilityRecord | undefined>;

  // Raw fetch by (owner, id, exact version) — used to resolve an ADOPTED cross-tenant reference. The CALLER applies
  // canConsumeCapability (this returns the row regardless of the reader's access). undefined if absent/deleted.
  getVersion(owner: string, id: string, version: string): Promise<CapabilityRecord | undefined>;

  // Live versions of the owner's capability, sorted ascending (semver). Empty if none.
  versions(tenant: string, id: string): Promise<string[]>;

  // Browse "my store": the latest live version of every capability this workspace can use WITHOUT the global public
  // catalog — own private (creator's) + own workspace + own subset + subset shared to this tenant. Newest first.
  listVisible(tenant: string, subject: string): Promise<CapabilityRecord[]>;

  // Browse the global public catalog: the latest live version of every visibility='public' capability. Newest first.
  listPublic(): Promise<CapabilityRecord[]>;

  // Capability-level MUTABLE metadata (outside version immutability): change the reach across every live version.
  setVisibility(
    tenant: string,
    id: string,
    next: { visibility: CapabilityVisibility; sharedWith: string[] },
  ): Promise<void>;

  // Soft-delete a single version (tombstone; content preserved, excluded from every read).
  softDelete(tenant: string, id: string, version: string): Promise<void>;

  // The subject who registered a specific (owner-owned, live) version — for the creator-or-admin delete gate.
  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
}
