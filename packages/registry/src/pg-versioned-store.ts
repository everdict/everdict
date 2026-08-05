import type { VersionMeta } from "@everdict/application-control";
import { BadRequestError, type CapabilityOrigin, ConflictError, NotFoundError } from "@everdict/contracts";
import type { SqlClient } from "@everdict/db";
import {
  SHARED_TENANT,
  parseCapabilityOrigin,
  parseVersionTags,
  resolveRef,
  sortVersions,
  specsEqual,
} from "./registry.js";

// Per-entity persistence config. Column names and optional-column capabilities diverge across the versioned
// tables (everdict_datasets stores the jsonb in a `dataset` column with created_by/deleted_at/tags; everdict_models
// stores it in `model` with none of those). The generic store adapts its SQL to these knobs so one implementation
// backs every table — a clause that references a column the table doesn't have (deleted_at, created_by, tags) is
// omitted entirely rather than defaulted (a table without deleted_at must never see `deleted_at IS NULL`).
export interface PgVersionedStoreConfig<T> {
  table: string; // trusted constant (code-provided) — interpolated into SQL
  column: string; // the jsonb column holding the spec (spec | dataset | judge | model | rubric | runtime)
  label: string; // human-facing entity name for error messages
  parse: (v: unknown) => T;
  softDelete?: boolean; // table has a deleted_at column → reads filter it out, register revives, softDelete exposed
  createdBy?: boolean; // table has a created_by column → INSERT stamps it, creatorOfVersion + list createdBy derive from it
  // table has a team_id column (migration 0106) → INSERT stamps it and teamOfVersion reads it. Ownership is
  // metadata beside created_by, never inside the versioned spec: transferring it must not mint a new version.
  teamId?: boolean;
  tags?: boolean; // table has a tags jsonb column (migration 0047/0054) → setVersionTags/versionTags + list versionTags
  // table has an origin jsonb column (migration 0111) → INSERT stamps it and listMeta/versionOrigins read it.
  // Provenance beside created_by/team_id, never inside the spec (see records/capability-origin.ts).
  origin?: boolean;
}

// The spec-column value is read back under the table's own column name (dataset/judge/spec/…), keyed dynamically.
type SpecRow = Record<string, unknown>;

// Postgres version of (tenant, id, version) → T. _shared fallback + latest/semver + immutable versions. Table/column
// are trusted constants (code-provided, never user input). One store backs every versioned Pg table via per-entity
// config; the capabilities a table lacks are simply not wired (its outer registry never calls them).
export class PgVersionedStore<T extends { id: string; version: string }> {
  private readonly table: string;
  private readonly column: string;
  private readonly label: string;
  private readonly parse: (v: unknown) => T;
  private readonly hasSoftDelete: boolean;
  private readonly hasCreatedBy: boolean;
  private readonly hasTeamId: boolean;
  private readonly hasTags: boolean;
  private readonly hasOrigin: boolean;

  constructor(
    private readonly client: SqlClient,
    config: PgVersionedStoreConfig<T>,
  ) {
    this.table = config.table;
    this.column = config.column;
    this.label = config.label;
    this.parse = config.parse;
    this.hasSoftDelete = config.softDelete ?? false;
    this.hasCreatedBy = config.createdBy ?? false;
    this.hasTeamId = config.teamId ?? false;
    this.hasTags = config.tags ?? false;
    this.hasOrigin = config.origin ?? false;
  }

  // " AND deleted_at IS NULL" only where the table has the column — otherwise the clause would reference a missing column.
  private get live(): string {
    return this.hasSoftDelete ? " AND deleted_at IS NULL" : "";
  }

  private async ownsId(tenant: string, id: string): Promise<boolean> {
    const r = await this.client.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live} LIMIT 1`, [
      tenant,
      id,
    ]);
    return r.rows.length > 0;
  }
  private async ownerOf(tenant: string, id: string): Promise<string | undefined> {
    if (await this.ownsId(tenant, id)) return tenant;
    if (tenant !== SHARED_TENANT && (await this.ownsId(SHARED_TENANT, id))) return SHARED_TENANT;
    return undefined;
  }
  private async ownerVersions(owner: string, id: string): Promise<string[]> {
    const r = await this.client.query<{ version: string }>(
      `SELECT version FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
      [owner, id],
    );
    return sortVersions(r.rows.map((x) => x.version));
  }

  async register(
    tenant: string,
    item: T,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
  ): Promise<void> {
    // Non-empty version invariant (parity with VersionedStore) — a blank version sorts to the tail as non-semver and
    // silently becomes `latest`. Reject it before the write.
    if (item.version.trim().length === 0) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant, id: item.id },
        `${this.label} ${item.id}: version must be a non-empty string.`,
      );
    }
    // The conflict/revive probe is the ONE read that omits deleted_at, so it can see a tombstone and revive it.
    // For a table without soft-delete, there is nothing to revive — the probe reads only the spec column.
    const existing = await this.client.query<SpecRow & { deleted_at: string | Date | null }>(
      `SELECT ${this.column}${this.hasSoftDelete ? ", deleted_at" : ""} FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3`,
      [tenant, item.id, item.version],
    );
    const row = existing.rows[0];
    if (row) {
      if (!specsEqual(row[this.column], item)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: item.id, version: item.version },
          `${this.label} ${item.id}@${item.version} is already registered with a different spec (versions are immutable).`,
        );
      }
      // re-registering identical content = revive — content immutability is preserved (same pattern as dataset tombstones).
      if (this.hasSoftDelete && row.deleted_at !== null)
        await this.client.query(
          `UPDATE ${this.table} SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = $3`,
          [tenant, item.id, item.version],
        );
      // A revive may ADOPT an unowned version, but never moves an owned one to another team — transferring
      // ownership is its own act, and doing it as a side effect of re-registering identical content would move a
      // resource out from under whoever could write it (`team_id IS NULL` is the guard, not an UPDATE).
      if (this.hasTeamId && teamId !== undefined)
        await this.client.query(
          `UPDATE ${this.table} SET team_id = $4 WHERE tenant = $1 AND id = $2 AND version = $3 AND team_id IS NULL`,
          [tenant, item.id, item.version, teamId],
        );
      // Provenance fills an unstamped version and never rewrites a stamped one (`origin IS NULL` is the guard):
      // re-registering identical content is not a second birth, so the first answer to "where did this come
      // from" is the one that stands.
      if (this.hasOrigin && origin !== undefined)
        await this.client.query(
          `UPDATE ${this.table} SET origin = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3 AND origin IS NULL`,
          [tenant, item.id, item.version, JSON.stringify(origin)],
        );
      return;
    }
    const columns = ["tenant", "id", "version", this.column, "created_at"];
    const values: unknown[] = [tenant, item.id, item.version, JSON.stringify(item)];
    const placeholders = ["$1", "$2", "$3", "$4", "now()"];
    if (this.hasCreatedBy) {
      columns.push("created_by");
      values.push(createdBy ?? null);
      placeholders.push(`$${values.length}`);
    }
    if (this.hasTeamId) {
      columns.push("team_id");
      values.push(teamId ?? null);
      placeholders.push(`$${values.length}`);
    }
    if (this.hasOrigin) {
      columns.push("origin");
      values.push(origin === undefined ? null : JSON.stringify(origin));
      placeholders.push(`$${values.length}::jsonb`);
    }
    await this.client.query(
      `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values,
    );
  }

  // Which team owns this version — the input the authz kernel's team axis needs. Undefined for an unowned
  // (seed/_shared/legacy) version, which is NOT the same as "everyone's".
  async teamOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    if (!this.hasTeamId) return undefined;
    const r = await this.client.query<{ team_id: string | null }>(
      `SELECT team_id FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3${this.live}`,
      [tenant, id, version],
    );
    return r.rows[0]?.team_id ?? undefined;
  }

  // Ownership transfer — the whole entity, every version of it. See the InMemory twin for why it is entity-wide
  // (reads answer ownership off the newest version, so a split id would change owner on the next release) and why
  // the UPDATE deliberately omits `this.live` (a revived tombstone must not reappear under the previous team).
  // The existence check DOES require a live version: an all-tombstoned id is invisible to every read.
  // (Only wired for tables that HAVE the column — the same contract every optional capability here follows: a
  // registry over a table without team_id never calls this, exactly as it never calls setVersionTags.)
  async moveToTeam(tenant: string, id: string, teamId: string): Promise<void> {
    if ((await this.ownerVersions(tenant, id)).length === 0)
      throw new NotFoundError("NOT_FOUND", { tenant, id }, `${this.label} '${id}' not found.`);
    await this.client.query(`UPDATE ${this.table} SET team_id = $3 WHERE tenant = $1 AND id = $2`, [
      tenant,
      id,
      teamId,
    ]);
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return false;
    const r = await this.client.query(
      `SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3${this.live}`,
      [owner, id, version],
    );
    return r.rows.length > 0;
  }

  // tenant directly-owned + live versions only (no fallback — _shared can't be deleted). NotFound otherwise. Same pattern as datasets.
  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    const r = await this.client.query<{ created_by: string | null }>(
      `SELECT created_by FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3${this.live}`,
      [tenant, id, version],
    );
    const row = r.rows[0];
    if (!row)
      throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `${this.label} ${id}@${version} not found.`);
    return row.created_by ?? undefined;
  }

  // version tag replacement (full-array PUT semantics) — tenant directly-owned + live versions only (same discipline as softDelete; _shared can't be tagged).
  // Tags are a mutable metadata column — outside the spec jsonb, so they don't factor into specsEqual/version immutability. Migration 0047.
  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const r = await this.client.query<{ version: string }>(
      `UPDATE ${this.table} SET tags = $4::jsonb WHERE tenant = $1 AND id = $2 AND version = $3${this.live} RETURNING version`,
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
      `SELECT version, tags FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
      [owner, id],
    );
    const out: Record<string, string[]> = {};
    for (const row of r.rows) {
      const tags = parseVersionTags(row.tags);
      if (tags.length > 0) out[row.version] = tags;
    }
    return out;
  }

  // version → origin (only stamped live versions). Owner resolution matches versions() (incl. the _shared fallback).
  async versionOrigins(tenant: string, id: string): Promise<Record<string, CapabilityOrigin>> {
    if (!this.hasOrigin) return {};
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; origin: unknown }>(
      `SELECT version, origin FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
      [owner, id],
    );
    const out: Record<string, CapabilityOrigin> = {};
    for (const row of r.rows) {
      const origin = parseCapabilityOrigin(row.origin);
      if (origin) out[row.version] = origin;
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
      `SELECT ${this.column} FROM ${this.table} WHERE tenant = $1 AND id = $2 AND version = $3${this.live}`,
      [owner, id, version],
    );
    return this.parse((res.rows[0] as SpecRow)[this.column]);
  }

  async listIds(tenant: string): Promise<Array<{ id: string; versions: string[]; owner: string }>> {
    // Parenthesize the tenant OR only when a trailing " AND deleted_at IS NULL" follows (softDelete tables), so the
    // AND binds tighter than the OR; without soft-delete there is no trailing clause, so the bare OR stays byte-identical
    // to the former hand-rolled SQL (whose fake-SqlClient tests match the exact prefix).
    const tenantClause = this.hasSoftDelete ? `(tenant = $1 OR tenant = $2)${this.live}` : "tenant = $1 OR tenant = $2";
    const r = await this.client.query<{ id: string }>(
      `SELECT DISTINCT id FROM ${this.table} WHERE ${tenantClause} ORDER BY id`,
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
        team_id: string | null;
        tags: unknown;
        origin: unknown;
      }>(
        `SELECT version, created_at${this.hasCreatedBy ? ", created_by" : ""}${this.hasTeamId ? ", team_id" : ""}${this.hasTags ? ", tags" : ""}${this.hasOrigin ? ", origin" : ""} FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
        [owner, id],
      );
      const versions = sortVersions(r.rows.map((x) => x.version));
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const byTime = [...r.rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const earliest = byTime[0];
      const latest = byTime.at(-1);
      const latestVersionRow = r.rows.find((x) => x.version === latestVersion); // creator of the semver-latest version (≠ last-registered)
      const versionTags: Record<string, string[]> = {};
      const versionOrigins: Record<string, CapabilityOrigin> = {};
      for (const row of r.rows) {
        const tags = parseVersionTags(row.tags);
        if (tags.length > 0) versionTags[row.version] = tags;
        const origin = parseCapabilityOrigin(row.origin);
        if (origin) versionOrigins[row.version] = origin;
      }
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(earliest?.created_by != null ? { createdBy: earliest.created_by } : {}),
        ...(latestVersionRow?.created_by != null ? { latestCreatedBy: latestVersionRow.created_by } : {}),
        ...(latestVersionRow?.team_id != null ? { teamId: latestVersionRow.team_id } : {}),
        ...(earliest ? { createdAt: new Date(earliest.created_at).toISOString() } : {}),
        ...(latest ? { updatedAt: new Date(latest.created_at).toISOString() } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(Object.keys(versionOrigins).length > 0 ? { versionOrigins } : {}),
      });
    }
    return out;
  }
}
