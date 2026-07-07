import { ConflictError, NotFoundError } from "@everdict/core";
import type { SqlClient } from "@everdict/db";
import { SHARED_TENANT, parseVersionTags, resolveRef, sortVersions, specsEqual } from "./registry.js";
import type { VersionMeta } from "./versioned-store.js";

interface SpecRow {
  spec: unknown;
}

// Postgres version of (tenant, id, version) → T. _shared fallback + latest/semver + immutable versions. `table` is a trusted constant (code-provided).
// The Pg counterpart of the in-memory VersionedStore — shared by the harness taxonomy (template/instance) Pg registries.
export class PgVersionedStore<T extends { id: string; version: string }> {
  constructor(
    private readonly client: SqlClient,
    private readonly table: string,
    private readonly label: string,
    private readonly parse: (v: unknown) => T,
  ) {}

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query(
      `SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
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
      `SELECT version FROM ${this.table} WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL`,
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(tenant: string, item: T, createdBy?: string): Promise<void> {
    const existing = await this.client.query<SpecRow & { deleted_at: string | Date | null }>(
      `SELECT spec, deleted_at FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3`,
      [tenant, item.id, item.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row.spec, item)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: item.id, version: item.version },
          `${this.label} ${item.id}@${item.version} is already registered with a different spec (versions are immutable).`,
        );
      }
      // re-registering identical content = revive — content immutability is preserved (same pattern as dataset tombstones).
      if (row.deleted_at !== null)
        await this.client.query(
          `UPDATE ${this.table} SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3`,
          [tenant, item.id, item.version],
        );
      return;
    }
    await this.client.query(
      `INSERT INTO ${this.table} (tenant, id, version, spec, created_at, created_by) VALUES ($1, $2, $3, $4, now(), $5)`,
      [tenant, item.id, item.version, JSON.stringify(item), createdBy ?? null],
    );
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(
      `SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL`,
      [owner, id, version],
    );
    return r.rows.length > 0;
  }

  // tenant directly-owned + live versions only (no fallback — _shared can't be deleted). NotFound otherwise. Same pattern as datasets.
  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    const r = await this.client.query<{ created_by: string | null }>(
      `SELECT created_by FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL`,
      [tenant, id, version],
    );
    const row = r.rows[0];
    if (!row)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} not found.`);
    return row.created_by ?? undefined;
  }

  // version tag replacement (full-array PUT semantics) — tenant directly-owned + live versions only (same discipline as softDelete; _shared can't be tagged).
  // Tags are a mutable metadata column — outside spec(jsonb), so they don't factor into specsEqual/version immutability. Migration 0047.
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      `UPDATE ${this.table} SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version`,
      [tenant, id, version, JSON.stringify(tags)],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} not found.`);
  }

  // version → tags map (only live versions that have tags). Reads use owner resolution (including _shared fallback) — same view as versions().
  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; tags: unknown }>(
      `SELECT version, tags FROM ${this.table} WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL`,
      [owner, id],
    );
    const out: Record<string, string[]> = {};
    for (const row of r.rows) {
      const tags = parseVersionTags(row.tags);
      if (tags.length > 0) out[row.version] = tags;
    }
    return out;
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      `UPDATE ${this.table} SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version`,
      [tenant, id, version],
    );
    if (r.rows.length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} not found.`);
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = await this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id);
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<T> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' not found.`);
    const version = resolveRef(id, ref, await this.ownerVersions(owner, id));
    const res = await this.client.query<SpecRow>(
      `SELECT spec FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL`,
      [owner, id, version],
    );
    return this.parse((res.rows[0] as SpecRow).spec);
  }

  async listIds(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    const r = await this.client.query<{ id: string }>(
      `SELECT DISTINCT id FROM ${this.table} WHERE (tenant = $1 OR tenant = $2) AND deleted_at IS NULL ORDER BY id`,
      [tenant, SHARED_TENANT],
    );
    const out: Array<{ id: string; versions: string[]; owner: string }> = [];
    for (const { id } of r.rows) {
      const owner = (await this.ownerOf(tenant, id)) as string;
      out.push({ id, owner, versions: await this.ownerVersions(owner, id) });
    }
    return out;
  }

  // List metadata — per-id version summary + registration history (first subject/time, most recent time). Extracts only metadata, without parsing even the latest version's spec.
  async listMeta(tenant: string): Promise<VersionMeta[]> {
    const out: VersionMeta[] = [];
    for (const { id, owner } of await this.listIds(tenant)) {
      const r = await this.client.query<{
        version: string;
        created_at: string | Date;
        created_by: string | null;
        tags: unknown;
      }>(
        `SELECT version, created_at, created_by, tags FROM ${this.table} WHERE tenant = $1 AND id = $2 AND deleted_at IS NULL`,
        [owner, id],
      );
      const versions = sortVersions(r.rows.map((x) => x.version));
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const byTime = [...r.rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const earliest = byTime[0];
      const latest = byTime.at(-1);
      const versionTags: Record<string, string[]> = {};
      for (const row of r.rows) {
        const tags = parseVersionTags(row.tags);
        if (tags.length > 0) versionTags[row.version] = tags;
      }
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.created_by != null ? { createdBy: earliest.created_by } : {}),
        ...(earliest ? { createdAt: new Date(earliest.created_at).toISOString() } : {}),
        ...(latest ? { updatedAt: new Date(latest.created_at).toISOString() } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }
}
