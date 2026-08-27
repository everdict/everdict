import { BadRequestError, ConflictError, NotFoundError } from "@everdict/contracts";
import { LATEST, SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

import type { VersionMeta } from "@everdict/application-control";
import type { CapabilityOrigin } from "@everdict/contracts";

// Shared in-memory storage/resolution for (tenant, id, version) → T: _shared fallback, latest/semver, immutable versions.
// Shared by the harness taxonomy registries (template/instance) — a generalization of the former HarnessRegistry machinery.
interface Entry<T> {
  item: T;
  seq: number;
  createdAt: string; // registration time (ISO)
  createdBy?: string; // registering subject (absent for seed/file)
  // The OWNING TEAM. Metadata like createdBy, deliberately outside the versioned content: ownership can be
  // transferred, and rewriting a spec to do it would mint a new version of something that did not change.
  // Absent = unowned (seed/_shared/legacy) → the team gate does not apply. See can() in @everdict/domain.
  teamId?: string;
  deletedAt?: number; // soft-delete tombstone — once set, excluded from every read (content preserved, same pattern as datasets)
  tags?: string[]; // version tags — free-form labels attached because a version is hard to tell apart by number alone. Mutable metadata (outside content immutability, on par with createdBy)
  // WHERE this version came from (the issue it was built for, the agent + conversation that shaped it). Metadata
  // beside createdBy for the same reason ownership is: provenance must not mint a version of unchanged content.
  origin?: CapabilityOrigin;
}

export class VersionedStore<T extends { id: string; version: string }> {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry<T>>>>(); // tenant → id → version → Entry
  private seq = 0;
  constructor(private readonly label: string) {}

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .filter((e) => e.deletedAt === undefined) // exclude tombstones — deleted versions are invisible to every read
      .sort((a, b) => compareVersions(a.item.version, b.item.version) || a.seq - b.seq)
      .map((e) => e.item.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.ownerVersions(tenant, id).length > 0) return tenant;
    if (this.ownerVersions(SHARED_TENANT, id).length > 0) return SHARED_TENANT;
    return undefined;
  }

  // ── REGISTERING A SUCCESSOR WITHOUT A READ-THEN-WRITE WINDOW (arch-review 77) ────────────────────
  //
  // A caller that resolves the entity's owning team and then registers under it has a window: an ownership
  // transfer landing between the two writes the successor under a team that no longer owns the entity, and
  // the versions come apart — the exact split `teamOfVersion` was made REQUIRED to prevent.
  //
  //     owner value exists   ≠   owner value remains valid until the write
  //
  // Detecting that afterwards is the write-then-verify shape this repository just spent a wave removing. So
  // the value is not carried at all: the store resolves the current owner where the write happens. Ownership
  // moves the ENTITY (`moveToTeam` re-files every version), so any live version answers for all of them.
  registerPreservingOwner(tenant: string, item: T, createdBy?: string, origin?: CapabilityOrigin): void {
    this.register(tenant, item, createdBy, this.entityTeam(tenant, item.id), origin);
  }

  // The entity's owning team, read from its live versions. Undefined = unowned, which is the workspace's —
  // never "everyone's" (rule `api-layer`).
  private entityTeam(tenant: string, id: string): string | undefined {
    for (const entry of this.byOwner.get(tenant)?.get(id)?.values() ?? [])
      if (entry.deletedAt === undefined && entry.teamId !== undefined) return entry.teamId;
    return undefined;
  }

  register(tenant: string, item: T, createdBy?: string, teamId?: string, origin?: CapabilityOrigin): void {
    // Non-empty version is a registry invariant (defense-in-depth for seed/file paths that bypass the contract
    // VersionSchema): an empty/blank version is non-semver, so compareVersions sorts it to the tail → it silently
    // becomes `latest` and corrupts resolution + the detail view. Reject it here too.
    if (item.version.trim().length === 0) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant, id: item.id },
        `${this.label} ${item.id}: version must be a non-empty string.`,
      );
    }
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(item.id);
    if (!versions) {
      versions = new Map();
      ids.set(item.id, versions);
    }
    const existing = versions.get(item.version);
    if (existing) {
      if (!specsEqual(existing.item, item)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: item.id, version: item.version },
          `${this.label} ${item.id}@${item.version} is already registered with a different spec (versions are immutable).`,
        );
      }
      existing.deletedAt = undefined; // re-registering identical content = revive — content immutability is preserved
      // Ownership is metadata, so a revive may set it — but it never SILENTLY moves an owned version to another
      // team: transferring ownership is its own act, and doing it as a side effect of re-registering identical
      // content would move a resource out from under whoever could write it.
      if (existing.teamId === undefined && teamId !== undefined) existing.teamId = teamId;
      // Same rule for provenance: a revive may FILL an unstamped version, but never rewrites one that already
      // says where it came from — the first answer is the true one, and re-registering identical content is not
      // a new birth.
      if (existing.origin === undefined && origin !== undefined) existing.origin = origin;
      return;
    }
    versions.set(item.version, {
      item,
      seq: this.seq++,
      createdAt: new Date().toISOString(),
      ...(createdBy !== undefined ? { createdBy } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
  }

  has(tenant: string, id: string, version: string): boolean {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id).includes(version) : false;
  }

  // tenant directly-owned + live versions only (no fallback — _shared can't be deleted). NotFound otherwise. Same pattern as datasets.
  private ownLiveEntry(tenant: string, id: string, version: string): Entry<T> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version);
    if (!entry || entry.deletedAt !== undefined)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} not found.`);
    return entry;
  }

  // Which team owns this version — the input the authz kernel's team axis needs. Undefined for an unowned
  // (seed/_shared/legacy) version, which is NOT the same as "everyone's".
  teamOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.byOwner.get(tenant)?.get(id)?.get(version)?.teamId;
  }

  creatorOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.ownLiveEntry(tenant, id, version).createdBy;
  }

  // Ownership transfer — the ENTITY moves, so every one of its versions moves with it.
  //
  // Per-version transfer was the alternative and it is incoherent: reads already answer "whose is this?" off the
  // newest version (`teamOfEntity`), so a split id would change owner whenever a new release landed. Ownership
  // belongs to the thing, not to one release of it.
  //
  // Tombstones move too. They are excluded from every read, but re-registering identical content REVIVES one —
  // and a revived version reappearing under the team that no longer owns the id is a resource that walked back
  // across a boundary on its own.
  //
  // Tenant directly-owned only, and only while something of it is live: a `_shared` first-party asset is not a
  // workspace's to re-file, and an id whose every version is a tombstone is invisible to reads, so moving it
  // would be moving something that (as far as this workspace can tell) does not exist.
  moveToTeam(tenant: string, id: string, teamId: string): void {
    if (this.ownerVersions(tenant, id).length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' not found.`);
    for (const entry of this.byOwner.get(tenant)?.get(id)?.values() ?? []) entry.teamId = teamId;
  }

  // version tag replacement (full-array PUT semantics) — tenant directly-owned + live versions only (same discipline as softDelete; _shared can't be tagged).
  // Tags are mutable registry metadata — not spec content, so they don't factor into specsEqual/immutability.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): void {
    const entry = this.ownLiveEntry(tenant, id, version);
    entry.tags = tags.length > 0 ? tags : undefined; // empty array = removal (same idiom as revive's deletedAt=undefined)
  }

  // version → tags map (only live versions that have tags). Reads use owner resolution (including _shared fallback) — same view as versions().
  versionTags(tenant: string, id: string): Record<string, string[]> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.deletedAt === undefined && e.tags !== undefined && e.tags.length > 0) out[e.item.version] = e.tags;
    }
    return out;
  }

  // version → registration instant (live versions only). Reads resolve the owner like versions() does — a
  // `_shared` capability's timeline is its own registration history, not an empty map. The product timeline
  // reads this to place capability-version events on the axis.
  versionDates(tenant: string, id: string): Record<string, string> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.deletedAt === undefined) out[e.item.version] = e.createdAt;
    }
    return out;
  }

  // version → origin (only stamped live versions). Reads resolve the owner like versions() does, so a `_shared`
  // fallback answers with its own provenance rather than an empty map.
  versionOrigins(tenant: string, id: string): Record<string, CapabilityOrigin> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, CapabilityOrigin> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.deletedAt === undefined && e.origin !== undefined) out[e.item.version] = e.origin;
    }
    return out;
  }

  softDelete(tenant: string, id: string, version: string): void {
    this.ownLiveEntry(tenant, id, version).deletedAt = Date.now();
  }

  versions(tenant: string, id: string): string[] {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  ownVersions(tenant: string, id: string): string[] {
    return this.ownerVersions(tenant, id); // no fallback — for conflict checks
  }

  get(tenant: string, id: string, ref: string = LATEST): T {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry<T>).item;
  }

  listIds(tenant: string): Array<{ id: string; versions: string[]; owner: string }> {
    const ids = new Map<string, string>(); // id → owner (tenant takes precedence)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    return [...ids.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, owner]) => ({ id, owner, versions: this.ownerVersions(owner, id) }));
  }

  // List metadata — per-id version summary + registration history (first subject/time, most recent time). The upstream registry layers on spec derivations (category, etc.).
  listMeta(tenant: string): VersionMeta[] {
    const out: VersionMeta[] = [];
    for (const { id, owner } of this.listIds(tenant)) {
      const versions = this.ownerVersions(owner, id);
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue; // defensively exclude ids with no versions
      const entries = [...(this.byOwner.get(owner)?.get(id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
      const earliest = entries[0];
      const latest = entries.at(-1);
      const latestVersionEntry = this.byOwner.get(owner)?.get(id)?.get(latestVersion); // creator of the semver-latest version (≠ last-registered)
      const versionTags = this.versionTags(owner, id);
      const versionOrigins = this.versionOrigins(owner, id);
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
        ...(latestVersionEntry?.createdBy !== undefined ? { latestCreatedBy: latestVersionEntry.createdBy } : {}),
        ...(latestVersionEntry?.teamId !== undefined ? { teamId: latestVersionEntry.teamId } : {}),
        ...(earliest ? { createdAt: earliest.createdAt } : {}),
        ...(latest ? { updatedAt: latest.createdAt } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(Object.keys(versionOrigins).length > 0 ? { versionOrigins } : {}),
      });
    }
    return out;
  }
}
