import { type Dataset, NotFoundError } from "@everdict/core";
import { VersionedStore } from "../versioned-store.js";

// The port + its list-entry type now live in @everdict/application-control — re-architecture P2d compat re-export (removed in the P4 sweep).
export type { DatasetListEntry, DatasetRegistry } from "@everdict/application-control";
import type { DatasetListEntry, DatasetRegistry } from "@everdict/application-control";

// Delegates to the shared VersionedStore — datasets use its FULL surface (has/ownVersions/rich list/softDelete/createdBy/tags).
// Because datasets DO have tombstones, ownerOf's has-live-version semantics matter here (an all-tombstoned id disappears from
// reads) — the shared store already implements exactly that. The DatasetListEntry content fields (caseCount/tags/description/
// producedBy from the latest version) are the legitimate per-entity derivation layered on the shared listMeta.
export class InMemoryDatasetRegistry implements DatasetRegistry {
  private readonly store = new VersionedStore<Dataset>("Dataset");

  async register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
    this.store.register(tenant, dataset, createdBy);
  }
  async has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  async versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  async get(tenant: string, id: string, ref?: string): Promise<Dataset> {
    return this.store.get(tenant, id, ref);
  }
  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    this.store.softDelete(tenant, id, version);
  }
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    this.store.setVersionTags(tenant, id, version, tags);
  }
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<DatasetListEntry[]> {
    const out: DatasetListEntry[] = [];
    for (const meta of this.store.listMeta(tenant)) {
      const latest = this.store.get(meta.owner, meta.id, meta.latestVersion); // content from the latest version
      // A listed id always has ≥1 live version, so listMeta always stamped the registration times — guard rather than default.
      if (meta.createdAt === undefined || meta.updatedAt === undefined)
        throw new NotFoundError("NOT_FOUND", { tenant: meta.owner, id: meta.id }, `Dataset '${meta.id}' not found.`);
      out.push({
        id: meta.id,
        owner: meta.owner,
        versions: meta.versions,
        latestVersion: meta.latestVersion,
        caseCount: latest.cases.length,
        tags: latest.tags,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        ...(latest.description !== undefined ? { description: latest.description } : {}),
        ...(latest.producedBy !== undefined ? { producedBy: latest.producedBy } : {}),
        ...(meta.createdBy !== undefined ? { createdBy: meta.createdBy } : {}),
        ...(meta.versionTags !== undefined ? { versionTags: meta.versionTags } : {}),
      });
    }
    return out;
  }
}
