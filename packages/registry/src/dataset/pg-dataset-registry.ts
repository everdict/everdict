import { ConflictError, type Dataset, DatasetSchema, NotFoundError } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { SHARED_TENANT, parseVersionTags, resolveRef, sortVersions, specsEqual } from "../registry.js";
import type { DatasetListEntry, DatasetRegistry } from "./dataset-registry.js";

interface DatasetRow {
  dataset: unknown;
}

// Postgres-backed tenant-owned dataset SSOT. Key (tenant, id, version). Tenant-owned first, else _shared fallback.
// Schema: @everdict/db/migrations/0005_create_datasets (+ 0018: created_by/deleted_at). Same structure as PgHarnessRegistry.
// Soft delete: rows with deleted_at set are excluded from every read (WHERE deleted_at IS NULL) — data is preserved (reproducibility).
export class PgDatasetRegistry implements DatasetRegistry {
  constructor(private readonly client: SqlClient) {}

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
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      "SELECT version FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void> {
    // raw query — also sees tombstoned slots (version identity is immutable; re-registering identical content revives it).
    const existing = await this.client.query<DatasetRow & { deleted_at: string | null }>(
      "SELECT dataset, deleted_at FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3",
      [tenant, dataset.id, dataset.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.dataset, dataset)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: dataset.id, version: dataset.version },
          `Dataset ${dataset.id}@${dataset.version} is already registered with different content (versions are immutable).`,
        );
      }
      if (row.deleted_at !== null)
        await this.client.query(
          "UPDATE everdict_datasets SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3",
          [tenant, dataset.id, dataset.version],
        ); // re-registering identical content → revive
      return;
    }
    await this.client.query(
      "INSERT INTO everdict_datasets (tenant, id, version, dataset, created_by, created_at) VALUES ($1, $2, $3, $4, $5, now())",
      [tenant, dataset.id, dataset.version, JSON.stringify(dataset), createdBy ?? null],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(
      "SELECT 1 FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [owner, id, version],
    );
    return r.rows.length > 0;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // exactly this tenant's owned only (no fallback), live versions only
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<Dataset> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `Dataset '${id}' not found.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<DatasetRow>(
      "SELECT dataset FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [owner, id, version],
    );
    return DatasetSchema.parse((res.rows[0] as DatasetRow).dataset);
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

  // Summarizes an id's live versions into list metadata (DatasetListEntry). Parses only the latest version for content, and uses created_at for creation/update times.
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

  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    // tenant directly-owned + live versions only (no fallback — _shared can't be deleted).
    const r = await this.client.query<{ created_by: string | null }>(
      "SELECT created_by FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL",
      [tenant, id, version],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `Dataset ${id}@${version} not found.`);
    return row.created_by ?? undefined;
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      "UPDATE everdict_datasets SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
      [tenant, id, version],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `Dataset ${id}@${version} not found.`);
  }

  // version tag replacement (full-array PUT semantics) — tenant directly-owned + live versions only (same discipline as softDelete). Migration 0047.
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      "UPDATE everdict_datasets SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version",
      [tenant, id, version, JSON.stringify(tags)],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `Dataset ${id}@${version} not found.`);
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; tags: unknown }>(
      "SELECT version, tags FROM everdict_datasets WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL",
      [owner, id],
    );
    const out: Record<string, string[]> = {};
    for (const row of r.rows) {
      const rowTags = parseVersionTags(row.tags);
      if (rowTags.length > 0) out[row.version] = rowTags;
    }
    return out;
  }
}
