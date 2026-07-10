import { ConflictError, NotFoundError } from "@everdict/contracts";
import { LATEST, SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "./registry.js";

// The VersionMeta list-metadata type now lives in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { VersionMeta } from "@everdict/application-control";
import type { VersionMeta } from "@everdict/application-control";

// Shared in-memory storage/resolution for (tenant, id, version) → T: _shared fallback, latest/semver, immutable versions.
// Shared by the harness taxonomy registries (template/instance) — a generalization of the former HarnessRegistry machinery.
interface Entry<T> {
  item: T;
  seq: number;
  createdAt: string; // registration time (ISO)
  createdBy?: string; // registering subject (absent for seed/file)
  deletedAt?: number; // soft-delete tombstone — once set, excluded from every read (content preserved, same pattern as datasets)
  tags?: string[]; // version tags — free-form labels attached because a version is hard to tell apart by number alone. Mutable metadata (outside content immutability, on par with createdBy)
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

  register(tenant: string, item: T, createdBy?: string): void {
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
      return;
    }
    versions.set(item.version, {
      item,
      seq: this.seq++,
      createdAt: new Date().toISOString(),
      ...(createdBy !== undefined ? { createdBy } : {}),
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

  creatorOfVersion(tenant: string, id: string, version: string): string | undefined {
    return this.ownLiveEntry(tenant, id, version).createdBy;
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
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
        ...(latestVersionEntry?.createdBy !== undefined ? { latestCreatedBy: latestVersionEntry.createdBy } : {}),
        ...(earliest ? { createdAt: earliest.createdAt } : {}),
        ...(latest ? { updatedAt: latest.createdAt } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }
}
