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
  tags?: boolean; // table has a tags jsonb column (migration 0047/0054) → setVersionTags/versionTags + list versionTags
  // table has an origin jsonb column (migration 0111) → INSERT stamps it and listMeta/versionOrigins read it.
  // Provenance beside created_by, never inside the spec (see records/capability-origin.ts).
  origin?: boolean;
  // WHICH CAPABILITY KIND this store holds, for the resolution generation (migration 0163). A decision that
  // resolved a name has to be able to prove, at its commit, that the name still resolves the same way — and
  // `created_at` cannot carry that: a revive and a soft delete both change what a name answers while leaving
  // every timestamp in place. Absent = this store does not participate in that fence (runtimes, templates).
  generationKind?: "dataset" | "harness" | "judge" | "rubric" | "model";
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
  private readonly hasTags: boolean;
  private readonly hasOrigin: boolean;
  private readonly generationKind: PgVersionedStoreConfig<T>["generationKind"];

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
    this.hasTags = config.tags ?? false;
    this.hasOrigin = config.origin ?? false;
    this.generationKind = config.generationKind;
  }

  // BUMP THE NAME'S RESOLUTION GENERATION — every mutation that can change what `id` resolves to, not only
  // the ones that insert a row (arch-review 23 P0-2). Keyed by the NAME because that is what owner-first
  // resolution answers: reviving one version changes `latest` for every reader of it.
  //
  // THE BUMP RIDES INSIDE THE MUTATION'S OWN STATEMENT (arch-review 24 P0-1). Postgres runs a data-modifying
  // CTE as one atomic unit, so there is no instant in which the registry already answers the new resolution
  // while the generation still reads the old number — the exact window in which a decision reads the NEW
  // capability, reads the OLD token, and commits believing the world held still. That is also why the bump is
  // no longer best-effort: a swallowed failure produced precisely that state and called it success. A refused
  // registry write is recoverable; a silently unfenced one is a wrong verdict nobody can see.
  //
  // `mutation` must be the CTE body including its own RETURNING; the fence fires only for the rows it returns,
  // so a no-op UPDATE (nothing to revive, nothing to delete) advances nothing.
  private fenced(mutation: string, tail: string, kindIndex: number): string {
    return `WITH mutation AS (${mutation}),
       fence AS (
         INSERT INTO everdict_capability_generation (tenant, kind, id, generation, updated_at)
         SELECT $1, $${kindIndex}, $2, 1, now() FROM mutation
         ON CONFLICT (tenant, kind, id)
         DO UPDATE SET generation = everdict_capability_generation.generation + 1, updated_at = now()
       )
       ${tail}`;
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

  async register(tenant: string, item: T, createdBy?: string, origin?: CapabilityOrigin): Promise<void> {
    await this.registerReturning(tenant, item, createdBy, origin);
  }

  // The same write, with its ANSWER — `register` keeps `Promise<void>` because every other registry wrapper
  // forwards it and none of them authorizes anything (arch-review 115).
  private async registerReturning(
    tenant: string,
    item: T,
    createdBy?: string,
    origin?: CapabilityOrigin,
    opts?: {
      preserveEntityOwner?: boolean;
      authority?: { expectedOwnerTeamId?: string; initialTeamId?: string };
    },
  ): Promise<"registered"> {
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
      // ── WHAT AN EXACT RE-PRESENT MAY STILL DO ────────────────────────────────────────────────────
      //
      // Re-registering identical content is not a second birth, so this branch never rewrites anything that
      // already has an answer. Two effects survive the removal of the ownership axis: a REVIVE when the
      // version is a tombstone, and an origin FILL when it was stamped with no provenance.
      //
      // One statement, because two would leave a window between them — Postgres evaluates every arm of a CTE
      // against one snapshot, which is this repository's default for making writes atomic without a
      // transaction.
      const values: unknown[] = [tenant, item.id];
      let versionIdx: number | undefined;
      const version = () => {
        if (versionIdx === undefined) versionIdx = values.push(item.version);
        return `$${versionIdx}`;
      };
      const parts: string[] = [];
      if (this.hasSoftDelete && row.deleted_at !== null)
        // A REVIVE is the shadow that leaves no trace in `created_at` — a workspace-local document coming
        // back to life under a name a `_shared` document was answering.
        parts.push(
          `revived AS (UPDATE ${this.table} SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = ${version()} RETURNING 1)`,
        );
      if (this.hasOrigin && origin !== undefined) {
        values.push(JSON.stringify(origin));
        // Provenance fills an unstamped version and never rewrites a stamped one: the first answer to "where
        // did this come from" stands.
        parts.push(
          `origined AS (UPDATE ${this.table} SET origin = $${values.length}::jsonb WHERE tenant = $1 AND id = $2 AND version = ${version()} AND origin IS NULL RETURNING 1)`,
        );
      }
      // Nothing to revive and nothing to fill. Issuing a statement anyway would send parameters no arm
      // mentions, and Postgres refuses a statement it cannot type.
      if (parts.length === 0) return "registered";
      const settle = `WITH ${parts.join(", ")} SELECT 1`;
      await this.client.query(
        this.generationKind === undefined ? settle : this.fenced(settle, "SELECT 1", values.push(this.generationKind)),
        values,
      );
      return "registered";
    }
    const columns = ["tenant", "id", "version", this.column, "created_at"];
    const values: unknown[] = [tenant, item.id, item.version, JSON.stringify(item)];
    const placeholders = ["$1", "$2", "$3", "$4", "now()"];
    if (this.hasCreatedBy) {
      columns.push("created_by");
      values.push(createdBy ?? null);
      placeholders.push(`$${values.length}`);
    }
    if (this.hasOrigin) {
      columns.push("origin");
      values.push(origin === undefined ? null : JSON.stringify(origin));
      placeholders.push(`$${values.length}::jsonb`);
    }
    const insert = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING 1`;
    if (this.generationKind !== undefined) values.push(this.generationKind);
    const statement =
      this.generationKind === undefined ? insert : this.fenced(insert, "SELECT 1 FROM mutation", values.length);
    await this.client.query(statement, values);
    return "registered";
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

  // version → registration instant (live versions only). Owner resolution matches versions() (incl. the
  // _shared fallback). The product timeline reads this to place capability-version events on the axis.
  async versionDates(tenant: string, id: string): Promise<Record<string, string>> {
    const owner = await this.ownerOf(tenant, id);
    if (!owner) return {};
    const r = await this.client.query<{ version: string; created_at: string | Date }>(
      `SELECT version, created_at FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
      [owner, id],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows) out[row.version] = new Date(row.created_at).toISOString();
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
    // A soft DELETE changes resolution as surely as a registration does — removing a workspace-local version
    // lets the `_shared` document answer the name again, so the fence advances in the same statement.
    const remove = `UPDATE ${this.table} SET deleted_at = now() WHERE tenant = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING version`;
    const r = await this.client.query<{ version: string }>(
      this.generationKind === undefined ? remove : this.fenced(remove, "SELECT version FROM mutation", 4),
      this.generationKind === undefined ? [tenant, id, version] : [tenant, id, version, this.generationKind],
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
        tags: unknown;
        origin: unknown;
      }>(
        `SELECT version, created_at${this.hasCreatedBy ? ", created_by" : ""}${this.hasTags ? ", tags" : ""}${this.hasOrigin ? ", origin" : ""} FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}`,
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
        ...(earliest ? { createdAt: new Date(earliest.created_at).toISOString() } : {}),
        ...(latest ? { updatedAt: new Date(latest.created_at).toISOString() } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
        ...(Object.keys(versionOrigins).length > 0 ? { versionOrigins } : {}),
      });
    }
    return out;
  }
}
