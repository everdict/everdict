import { type Dataset, DatasetSchema, NotFoundError } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import { PgVersionedStore } from "../pg-versioned-store.js";
import { SHARED_TENANT, parseVersionTags, sortVersions } from "../registry.js";
import type { DatasetListEntry, DatasetRegistry } from "./dataset-registry.js";

// Postgres-backed tenant-owned dataset SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0005_create_datasets (+ 0018 created_by/deleted_at, 0047 tags) — the FULL versioned table.
// Delegates to the shared PgVersionedStore for the whole surface EXCEPT list(): a DatasetListEntry needs the latest
// dataset's content (caseCount/tags/description/producedBy) alongside the registration history, and it fetches both in a
// single per-id query (spec + metadata together). That fused shape is entity-specific — the generic listMeta reads only
// metadata (no spec column) — so list()/summarize() stay entity-local here rather than forking the shared invariant logic.
export class PgDatasetRegistry implements DatasetRegistry {
  private readonly store: PgVersionedStore<Dataset>;
  constructor(private readonly client: SqlClient) {
    this.store = new PgVersionedStore(client, {
      table: "everdict_datasets",
      column: "dataset",
      label: "Dataset",
      parse: (v) => DatasetSchema.parse(v),
      softDelete: true,
      createdBy: true,
      tags: true,
    });
  }

  register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
    return this.store.register(tenant, dataset, createdBy);
  }
  has(tenant: string, id: string, version: string): Promise<boolean> {
    return this.store.has(tenant, id, version);
  }
  versions(tenant: string, id: string): Promise<string[]> {
    return this.store.versions(tenant, id);
  }
  ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.store.ownVersions(tenant, id);
  }
  get(tenant: string, id: string, ref?: string): Promise<Dataset> {
    return this.store.get(tenant, id, ref);
  }
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    return this.store.creatorOfVersion(tenant, id, version);
  }
  softDelete(tenant: string, id: string, version: string): Promise<void> {
    return this.store.softDelete(tenant, id, version);
  }
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    return this.store.setVersionTags(tenant, id, version, tags);
  }
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    return this.store.versionTags(tenant, id);
  }

  async list(tenant: string): Promise<DatasetListEntry[]> {
    const r = await this.client.query<{ id: string }>(
      "SELECT DISTINCT id FROM everdict_datasets WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL ORDER BY id",
      [tenant, SHARED_TENANT],
    );
    const out: DatasetListEntry[] = [];
    for (const { id } of r.rows) {
      const owner = await this.ownerOf(tenant, id);
      if (owner) out.push(await this.summarize(owner, id)); // owner is effectively always present since id came from a live DISTINCT id
    }
    return out;
  }

  // Owner resolution reused by list() — tenant-owned live first, else _shared live. (get/has/etc. go through the store.)
  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query(
      "SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1",
      [tenant, id],
    );
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }

  // Summarizes an id's live versions into list metadata (DatasetListEntry). Parses only the latest version for content,
  // and reads spec + registration metadata in a single query (the fused shape is why list() stays entity-local).
  private async summarize(owner: string, id: string): Promise<DatasetListEntry> {
    const r = await this.client.query<{
      version: string;
      dataset: unknown;
      created_at: string | Date;
      created_by: string | null;
      tags: unknown;
    }>(
      "SELECT version, dataset, created_at, created_by, tags FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [owner, id],
    );
    const rows = r.rows;
    if (rows.length === 0) throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `Dataset '${id}' not found.`);
    const versions = sortVersions(rows.map((x) => x.version));
    const latestVersion = versions.at(-1);
    if (latestVersion === undefined)
      throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `Dataset '${id}' not found.`);
    const latestRow = rows.find((x) => x.version === latestVersion);
    if (!latestRow)
      throw new NotFoundError(
        "NOT_FOUND",
        { tenant: owner, id, version: latestVersion },
        `Dataset ${id}@${latestVersion} not found.`,
      );
    const latest = DatasetSchema.parse(latestRow.dataset);
    const byTime = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const earliest = byTime[0]; // first-registered version (creator, creation time)
    const newest = byTime[byTime.length - 1]; // latest-registered version (update time)
    if (!earliest || !newest) throw new NotFoundError("NOT_FOUND", { tenant: owner, id }, `Dataset '${id}' not found.`);
    const versionTags: Record<string, string[]> = {};
    for (const row of rows) {
      const rowTags = parseVersionTags(row.tags);
      if (rowTags.length > 0) versionTags[row.version] = rowTags;
    }
    return {
      id,
      owner,
      versions,
      latestVersion,
      caseCount: latest.cases.length,
      tags: latest.tags,
      createdAt: new Date(earliest.created_at).toISOString(),
      updatedAt: new Date(newest.created_at).toISOString(),
      ...(latest.description !== undefined ? { description: latest.description } : {}),
      ...(latest.producedBy !== undefined ? { producedBy: latest.producedBy } : {}),
      ...(earliest.created_by !== null ? { createdBy: earliest.created_by } : {}),
      ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
    };
  }
}
