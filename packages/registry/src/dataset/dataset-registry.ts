import { ConflictError, type Dataset, type DatasetProvenance, NotFoundError } from "@everdict/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "../registry.js";

// One list() entry — summarizes a single id (with several immutable versions) into list-view metadata. Content
// (case count / description / tags / provenance) comes from the latest semver version; creator and timestamps come
// from the registration history (createdAt=first registration, updatedAt=latest registration).
// _shared and file-seeded versions have no createdBy (undefined). GET /datasets and MCP list_datasets emit this shape verbatim.
export interface DatasetListEntry {
  id: string;
  owner: string;
  versions: string[]; // live versions (semver ascending)
  latestVersion: string; // latest semver version (source of the content fields below)
  caseCount: number; // case count of the latest version
  tags: string[]; // tags of the latest version
  description?: string; // description of the latest version (if any)
  producedBy?: DatasetProvenance; // ingest provenance of the latest version (recipe/catalog/spec; if any)
  createdBy?: string; // creator subject of the first-registered version (none for seed/_shared)
  createdAt?: string; // when the first version was registered (ISO)
  updatedAt?: string; // when the most recent version was registered (ISO)
  // Version tags — version → free-form label (only versions that have tags). Unlike content tags (entity classification),
  // these are registry metadata editable after registration (attached when versions are hard to tell apart by number alone).
  versionTags?: Record<string, string[]>;
}

// Dataset version SSOT — (tenant, id, version) → Dataset. Versions are immutable. "latest" = newest by semver/registration order.
// Same ownership model as the harness registry: tenant-owned first, else SHARED_TENANT (first-party benchmark) fallback.
// Harness-agnostic — the same dataset runs against several harness@version for baseline comparison. async — Postgres shares the contract.
export interface DatasetRegistry {
  // createdBy: subject that registered this version (for soft-delete authz — the creator themselves). No system seed / file loader (undefined).
  register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<Dataset>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback, deleted versions excluded
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks), deleted versions excluded
  list(tenant: string): Promise<DatasetListEntry[]>;
  // Creator subject of a live version this tenant directly owns (undefined if none). Missing/deleted/non-owned version → NotFound — no fallback.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Soft delete (tombstone) — preserve the data but exclude it from reads (keeps reproducibility). Tenant directly-owned only; missing/already-deleted version → NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form label, full replacement) — mutable registry metadata (outside content immutability). Tenant-owned live versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions that have tags). Reads resolve owner the same as versions() (including _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}

interface Entry {
  dataset: Dataset;
  seq: number; // registration order (for first/latest determination)
  createdAt: number; // registration time (ms) — the createdAt/updatedAt metadata in list
  createdBy?: string;
  deletedAt?: number; // tombstone — once set, excluded from every read (data is preserved)
  tags?: string[]; // version tags — mutable registry metadata (outside content immutability, on par with createdBy)
}

export class InMemoryDatasetRegistry implements DatasetRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  // Live (not deleted) versions only — sorted. The basis of every public read.
  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .filter((e) => e.deletedAt === undefined)
      .sort((a, b) => compareVersions(a.dataset.version, b.dataset.version) || a.seq - b.seq)
      .map((e) => e.dataset.version);
  }
  // Resolved owner: the tenant if it has a live version of id, else SHARED (if present), else undefined.
  // (If every version is a tombstone, that id is treated as absent — it disappears from read/resolve.)
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.ownerVersions(tenant, id).length > 0) return tenant;
    if (this.ownerVersions(SHARED_TENANT, id).length > 0) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(dataset.id);
    if (!versions) {
      versions = new Map();
      ids.set(dataset.id, versions);
    }
    const existing = versions.get(dataset.version); // raw — also sees tombstoned slots (version identity is immutable).
    if (existing) {
      if (!specsEqual(existing.dataset, dataset)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: dataset.id, version: dataset.version },
          `Dataset ${dataset.id}@${dataset.version} is already registered with different content (versions are immutable).`,
        );
      }
      if (existing.deletedAt !== undefined) existing.deletedAt = undefined; // re-registering identical content → revive
      return;
    }
    versions.set(dataset.version, {
      dataset,
      seq: this.seq++,
      createdAt: Date.now(),
      ...(createdBy !== undefined ? { createdBy } : {}),
    });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id).includes(version) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // exactly this tenant's owned only (no fallback), live versions only
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<Dataset> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `Dataset '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).dataset;
  }

  async list(tenant: string): Promise<DatasetListEntry[]> {
    const ids = new Map<string, string>(); // id → owner (tenant-first); only ids with at least one live version.
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? [])
      if (this.ownerVersions(SHARED_TENANT, id).length > 0) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? [])
      if (this.ownerVersions(tenant, id).length > 0) ids.set(id, tenant);
    return [...ids.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, owner]) => this.summarize(owner, id));
  }

  // Summarizes one id into list metadata (DatasetListEntry). Content from the latest version, creator and timestamps from the registration history.
  private summarize(owner: string, id: string): DatasetListEntry {
    const slot = this.byOwner.get(owner)?.get(id);
    const live = [...(slot?.values() ?? [])].filter((e) => e.deletedAt === undefined);
    const versions = this.ownerVersions(owner, id);
    const latestVersion = versions.at(-1);
    if (latestVersion === undefined)
      throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `Dataset '${id}' not found.`);
    const latest = live.find((e) => e.dataset.version === latestVersion);
    if (!latest)
      throw new NotFoundError(
        "NOT_FOUND",
        { tenant: owner, id, version: latestVersion },
        `Dataset ${id}@${latestVersion} not found.`,
      );
    const earliest = live.reduce((a, b) => (a.seq <= b.seq ? a : b)); // first-registered version (creator, creation time)
    const newest = live.reduce((a, b) => (a.seq >= b.seq ? a : b)); // latest-registered version (update time)
    const versionTags: Record<string, string[]> = {};
    for (const e of live) if (e.tags !== undefined && e.tags.length > 0) versionTags[e.dataset.version] = e.tags;
    return {
      id,
      owner,
      versions,
      latestVersion,
      caseCount: latest.dataset.cases.length,
      tags: latest.dataset.tags,
      createdAt: new Date(earliest.createdAt).toISOString(),
      updatedAt: new Date(newest.createdAt).toISOString(),
      ...(latest.dataset.description !== undefined ? { description: latest.dataset.description } : {}),
      ...(latest.dataset.producedBy !== undefined ? { producedBy: latest.dataset.producedBy } : {}),
      ...(earliest.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
      ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
    };
  }

  // Only live versions this tenant directly owns (no fallback — _shared can't be deleted). NotFound otherwise.
  private ownLiveEntry(tenant: string, id: string, version: string): Entry {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version);
    if (!entry || entry.deletedAt !== undefined)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `Dataset ${id}@${version} not found.`);
    return entry;
  }

  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.ownLiveEntry(tenant, id, version).createdBy;
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.ownLiveEntry(tenant, id, version).deletedAt = Date.now();
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const entry = this.ownLiveEntry(tenant, id, version);
    entry.tags = tags.length > 0 ? tags : undefined; // empty array = remove (same idiom as revive's deletedAt=undefined)
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.deletedAt === undefined && e.tags !== undefined && e.tags.length > 0) out[e.dataset.version] = e.tags;
    }
    return out;
  }
}
