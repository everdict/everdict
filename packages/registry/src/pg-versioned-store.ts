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
  private readonly hasTeamId: boolean;
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
    this.hasTeamId = config.teamId ?? false;
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

  // ── REGISTERING A SUCCESSOR WITHOUT A READ-THEN-WRITE WINDOW (arch-review 77) ────────────────────
  //
  // A caller that resolves the entity's owning team and then registers under it has a window: an ownership
  // transfer landing in between writes the successor under a team that no longer owns the entity, and the
  // entity's versions come apart — the split `teamOfVersion` was made REQUIRED to prevent.
  //
  //     owner value exists   ≠   owner value remains valid until the write
  //
  // Detecting that afterwards is the write-then-verify shape arch-review 76 removed one layer up. So the
  // value is not carried at all: the owner is read INSIDE the statement that writes. Ownership moves the
  // ENTITY (`moveToTeam` re-files every version), so any live version answers for all of them — which is
  // what makes a single scalar subquery a faithful reading rather than a guess about ordering.
  // ── …AND THE OWNER THE CALLER WAS AUTHORIZED AGAINST (arch-review 115) ──────────────────────────
  //
  // Same statement, one more assertion. The route reads `teamOfEntity` to gate and this re-reads it to write;
  // a transfer between them lands the successor under a team the caller may not write to. `expectedOwnerTeamId`
  // is what the gate saw, checked WHERE the current owner is resolved — so the pair is decided together or
  // not at all — and a mismatch inserts nothing and answers `owner_moved`.
  //
  // `initialTeamId` covers the entity with no LOCAL owner: `ownerOf` falls back to `_shared`, this subquery
  // does not, so a `_shared`-only candidate's first workspace version used to be born unowned.
  async registerPreservingOwner(
    tenant: string,
    item: T,
    createdBy?: string,
    origin?: CapabilityOrigin,
    authority?: { expectedOwnerTeamId?: string; initialTeamId?: string },
  ): Promise<"registered" | "owner_moved"> {
    return await this.registerReturning(tenant, item, createdBy, undefined, origin, {
      preserveEntityOwner: true,
      ...(authority !== undefined ? { authority } : {}),
    });
  }

  async register(
    tenant: string,
    item: T,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
    opts?: {
      preserveEntityOwner?: boolean;
      authority?: { expectedOwnerTeamId?: string; initialTeamId?: string };
    },
  ): Promise<void> {
    await this.registerReturning(tenant, item, createdBy, teamId, origin, opts);
  }

  // The same write, with its ANSWER — `register` keeps `Promise<void>` because every other registry wrapper
  // forwards it and none of them authorizes anything (arch-review 115).
  private async registerReturning(
    tenant: string,
    item: T,
    createdBy?: string,
    teamId?: string,
    origin?: CapabilityOrigin,
    opts?: {
      preserveEntityOwner?: boolean;
      authority?: { expectedOwnerTeamId?: string; initialTeamId?: string };
    },
  ): Promise<"registered" | "owner_moved"> {
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
      // ── THE EXACT-VERSION LANE ASKS THE SAME OWNER QUESTION AS THE INSERT (arch-review 120) ──────
      //
      // This branch used to return "registered" without consulting `authority` at all, under a comment
      // saying "nothing was written, and nothing about ownership was contradicted". Both halves were false:
      // the branch REVIVES a tombstone, FILLS a team and FILLS an origin, and the caller was authorized
      // against an owner that may have moved since.
      //
      //     same identity   ≠   authority still valid
      //
      // The in-memory twin has always checked first — `registerPreservingOwner` asks before it registers —
      // so every unit test of this refusal passed while the adapter that production runs waved the exact
      // case through: re-present the version the proof approved, after the entity moved teams, and the
      // adoption operation was spent against a team the caller cannot write to. A tombstoned exact version
      // made it worse: the same call REVIVED somebody else's version.
      //
      // One statement, because two would put the window back. Postgres evaluates every arm of a CTE against
      // one snapshot, so the owner is read once and the three effects either all see an authorized world or
      // none of them run — the repository's own default for making writes atomic without a transaction.
      const owner = `(SELECT team_id FROM ${this.table} WHERE tenant = $1 AND id = $2 AND team_id IS NOT NULL${this.live} LIMIT 1)`;
      const localEntity = `EXISTS (SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live})`;
      // ⚠️ Only what the statement REFERENCES. A parameter no arm mentions makes Postgres refuse the whole
      // statement ("could not determine data type of parameter $n"), and the authority-only shape — refuse,
      // with nothing to revive and nothing to fill — mentions neither the version nor a team.
      const values: unknown[] = [tenant, item.id];
      let versionIdx: number | undefined;
      const version = () => {
        if (versionIdx === undefined) versionIdx = values.push(item.version);
        return `$${versionIdx}`;
      };
      // What the caller may fill an UNOWNED version with: the entity's own owner if it has one, else the
      // authority that caused the write (`initialTeamId`), else what an ordinary register offered.
      const fill = opts?.authority?.initialTeamId ?? teamId ?? null;
      let authorized: string;
      if (opts?.authority !== undefined && this.hasTeamId) {
        values.push(opts.authority.expectedOwnerTeamId ?? null);
        // `IS NOT DISTINCT FROM` so an expectation of "unowned" is a real claim rather than a NULL that
        // compares to nothing — the same predicate the INSERT lane carries.
        authorized = `NOT (${localEntity} AND ${owner} IS DISTINCT FROM $${values.length})`;
      } else if (this.hasTeamId && teamId !== undefined) {
        values.push(teamId);
        // The ordinary lane's rule (arch-review 119): silence preserves, a DIFFERING team is a re-file and
        // `moveToTeam` owns that act.
        authorized = `(${owner} IS NULL OR $${values.length} IS NULL OR ${owner} = $${values.length})`;
      } else {
        authorized = "TRUE";
      }
      const parts = [`authorized AS (SELECT 1 WHERE ${authorized})`];
      if (this.hasSoftDelete && row.deleted_at !== null)
        // A REVIVE is the shadow that leaves no trace in `created_at` — a workspace-local document coming
        // back to life under a name a `_shared` document was answering.
        parts.push(
          `revived AS (UPDATE ${this.table} SET deleted_at = NULL WHERE tenant = $1 AND id = $2 AND version = ${version()} AND EXISTS (SELECT 1 FROM authorized) RETURNING 1)`,
        );
      if (this.hasTeamId && fill !== null) {
        values.push(fill);
        // Fills an UNOWNED version and never moves an owned one — transferring ownership is its own act, and
        // doing it as a side effect of re-registering identical content would move a resource out from under
        // whoever could write it. `COALESCE` so the entity's own owner wins over what the caller offered.
        parts.push(
          `teamed AS (UPDATE ${this.table} SET team_id = COALESCE(${owner}, $${values.length}) WHERE tenant = $1 AND id = $2 AND version = ${version()} AND team_id IS NULL AND EXISTS (SELECT 1 FROM authorized) RETURNING 1)`,
        );
      }
      if (this.hasOrigin && origin !== undefined) {
        values.push(JSON.stringify(origin));
        // Provenance fills an unstamped version and never rewrites a stamped one: re-registering identical
        // content is not a second birth, so the first answer to "where did this come from" stands.
        parts.push(
          `origined AS (UPDATE ${this.table} SET origin = $${values.length}::jsonb WHERE tenant = $1 AND id = $2 AND version = ${version()} AND origin IS NULL AND EXISTS (SELECT 1 FROM authorized) RETURNING 1)`,
        );
      }
      // Nothing to assert and nothing to write — a table with no team_id, no tombstone to revive and no
      // origin to fill. Issuing the statement anyway would send parameters no arm mentions, and Postgres
      // refuses a statement it cannot type ("could not determine data type of parameter $1"). Found by
      // taking a neutralized build's failure seriously instead of reading it as the guard working.
      if (authorized === "TRUE" && parts.length === 1) return "registered";
      const settle = `WITH ${parts.join(", ")} SELECT 1 FROM authorized`;
      const settled = await this.client.query(
        this.generationKind === undefined
          ? settle
          : this.fenced(settle, "SELECT 1 FROM authorized", values.push(this.generationKind)),
        values,
      );
      if (settled.rows.length > 0) return "registered";
      // Nothing ran, because the world is not the one the caller was authorized against. The two lanes
      // answer differently for the same reason the INSERT does: an authority ASKED a question, while an
      // ordinary register DECLARED a team over an entity that already has one.
      if (opts?.authority !== undefined) return "owner_moved";
      throw new ConflictError(
        "CONFLICT",
        { tenant, id: item.id, requested: teamId ?? null },
        `${this.label} '${item.id}' belongs to another team — registering a version cannot move it. Transfer it first, then register.`,
      );
    }
    const columns = ["tenant", "id", "version", this.column, "created_at"];
    const values: unknown[] = [tenant, item.id, item.version, JSON.stringify(item)];
    const placeholders = ["$1", "$2", "$3", "$4", "now()"];
    // Set when this INSERT writes a caller-supplied team; the refusal below reads the same parameter, so the
    // value written and the claim asserted are one read of one thing (rule `protocol` L3).
    let newVersionTeamIdx: number | undefined;
    if (this.hasCreatedBy) {
      columns.push("created_by");
      values.push(createdBy ?? null);
      placeholders.push(`$${values.length}`);
    }
    if (this.hasTeamId) {
      columns.push("team_id");
      if (opts?.preserveEntityOwner === true) {
        // Resolved in the INSERT, so no transfer can land between reading the owner and writing the row.
        const owner = `(SELECT team_id FROM ${this.table} WHERE tenant = $1 AND id = $2 AND team_id IS NOT NULL${this.live} LIMIT 1)`;
        if (opts.authority !== undefined) {
          values.push(opts.authority.initialTeamId ?? null);
          // COALESCE, not a second statement: an entity with no local owner takes the authority that caused
          // the write, decided in the same place the existing owner is read.
          placeholders.push(`COALESCE(${owner}, $${values.length})`);
        } else {
          placeholders.push(owner);
        }
      } else {
        // ── AN ORDINARY REGISTER MAY NOT RE-FILE THE ENTITY EITHER (arch-review 119) ──────────────
        //
        // This wrote the caller's team verbatim, so registering `2.0.0` of an id another team owns moved the
        // whole entity: ownership is read off the newest version. The in-memory twin refuses that now, and a
        // guard only one adapter has is a guard no deployment can rely on (rule `testing`).
        //
        // COALESCE, not the bare parameter: SILENCE preserves the owner instead of unowning the entity — an
        // unowned capability is writable by every team, which is the same takeover without a name on it. A
        // DIFFERING team is refused by `ownerUnchanged` below.
        values.push(teamId ?? null);
        newVersionTeamIdx = values.length;
        placeholders.push(`COALESCE(${this.entityOwnerExpr}, $${values.length})`);
      }
    }
    if (this.hasOrigin) {
      columns.push("origin");
      values.push(origin === undefined ? null : JSON.stringify(origin));
      placeholders.push(`$${values.length}::jsonb`);
    }
    // The authority precondition rides the INSERT itself — `SELECT … WHERE NOT EXISTS` rather than VALUES —
    // so "who owns this entity" is read once, for both the value written and the refusal.
    let insert = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING 1`;
    // What an empty result MEANS, decided where the statement is built rather than read off the row count.
    // The two guarded forms are mutually exclusive and answer differently: the authority lane asked a
    // question and gets `owner_moved`; the ordinary lane DECLARED a team over an entity that already has one,
    // which is a conflict nobody asked about.
    let refusedAs: "owner_moved" | "conflict" | undefined;
    if (opts?.authority !== undefined && this.hasTeamId) {
      refusedAs = "owner_moved";
      values.push(opts.authority.expectedOwnerTeamId ?? null);
      const expected = `$${values.length}`;
      // Refuse only when there IS a local entity whose resolved owner differs. A `_shared`-only or new id has
      // no claim to contradict, which is the case `initialTeamId` is for. `IS DISTINCT FROM` so that an
      // expectation of "unowned" is a real claim rather than a NULL that compares to nothing.
      insert =
        `INSERT INTO ${this.table} (${columns.join(", ")}) ` +
        `SELECT ${placeholders.join(", ")} ` +
        `WHERE NOT (EXISTS (SELECT 1 FROM ${this.table} WHERE tenant = $1 AND id = $2${this.live}) ` +
        `AND ${this.entityOwnerExpr} IS DISTINCT FROM ${expected}) RETURNING 1`;
    } else if (newVersionTeamIdx !== undefined) {
      // The re-file refusal rides the same INSERT, so the owner is read once — for the value written by the
      // COALESCE above AND for this guard.
      refusedAs = "conflict";
      insert =
        `INSERT INTO ${this.table} (${columns.join(", ")}) ` +
        `SELECT ${placeholders.join(", ")} ` +
        `WHERE ${this.entityOwnerExpr} IS NULL OR $${newVersionTeamIdx} IS NULL ` +
        `OR ${this.entityOwnerExpr} = $${newVersionTeamIdx} RETURNING 1`;
    }
    if (this.generationKind !== undefined) values.push(this.generationKind);
    const statement =
      this.generationKind === undefined ? insert : this.fenced(insert, "SELECT 1 FROM mutation", values.length);
    const { rows } = await this.client.query(statement, values);
    if (rows.length > 0 || refusedAs === undefined) return "registered";
    if (refusedAs === "conflict") throw this.entityBelongsToAnotherTeam(tenant, item.id, teamId);
    return "owner_moved";
  }

  // The entity's owner, resolved IN the statement that uses it: any live version with a team answers for all
  // of them, because a transfer moves every version at once and a split is what this guard refuses to create.
  private get entityOwnerExpr(): string {
    return `(SELECT team_id FROM ${this.table} WHERE tenant = $1 AND id = $2 AND team_id IS NOT NULL${this.live} LIMIT 1)`;
  }

  private entityBelongsToAnotherTeam(tenant: string, id: string, requested?: string): ConflictError {
    return new ConflictError(
      "CONFLICT",
      { tenant, id, requested: requested ?? null },
      `${this.label} '${id}' belongs to another team — registering a version cannot move it. Transfer it first, then register.`,
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
