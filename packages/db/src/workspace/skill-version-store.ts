import type { SkillVersionStore } from "@everdict/application-control";
import { ConflictError, type SkillVersionRecord, SkillVersionRecordSchema } from "@everdict/contracts";
import { compareVersions } from "@everdict/domain";

import type { SqlClient } from "../client.js";

// A skill's stamped versions — see the port for the contract. Both impls treat ONE rule as sacred: stamping a
// (tenant, skillId, version) that already exists throws ConflictError instead of overwriting. A stamped version is a
// fixed point somebody may have cited; rewriting it would make the citation lie.

const newestFirst = (a: SkillVersionRecord, b: SkillVersionRecord): number => compareVersions(b.version, a.version);

const conflict = (record: SkillVersionRecord): ConflictError =>
  new ConflictError(
    "CONFLICT",
    { id: record.skillId, version: record.version },
    `version ${record.version} of skill '${record.skillId}' is already stamped`,
  );

export class InMemorySkillVersionStore implements SkillVersionStore {
  private readonly rows: SkillVersionRecord[] = [];

  async stamp(record: SkillVersionRecord): Promise<void> {
    if (await this.get(record.tenant, record.skillId, record.version)) throw conflict(record);
    this.rows.push(record);
  }

  async list(tenant: string, skillId: string): Promise<SkillVersionRecord[]> {
    return this.rows.filter((r) => r.tenant === tenant && r.skillId === skillId).sort(newestFirst);
  }

  async get(tenant: string, skillId: string, version: string): Promise<SkillVersionRecord | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.skillId === skillId && r.version === version);
  }

  async remove(tenant: string, skillId: string): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row && row.tenant === tenant && row.skillId === skillId) this.rows.splice(i, 1);
    }
  }
}

interface SkillVersionRow {
  tenant: string;
  skill_id: string;
  version: string;
  name: string;
  description: string;
  instructions: string;
  files: unknown;
  refs: unknown;
  note: string | null;
  stamped_by: string;
  stamped_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: SkillVersionRow): SkillVersionRecord {
  return SkillVersionRecordSchema.parse({
    skillId: row.skill_id,
    tenant: row.tenant,
    version: row.version,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: row.files ?? [],
    refs: row.refs ?? [],
    ...(row.note !== null ? { note: row.note } : {}),
    stampedBy: row.stamped_by,
    stampedAt: iso(row.stamped_at),
  });
}

// Postgres — the primary key enforces immutability. `ON CONFLICT DO NOTHING` + a returning-row check turns the race
// into our ConflictError without depending on driver-specific error codes (same shape as PgFsRevisionStore).
export class PgSkillVersionStore implements SkillVersionStore {
  constructor(private readonly client: SqlClient) {}

  async stamp(record: SkillVersionRecord): Promise<void> {
    const { rows } = await this.client.query<{ version: string }>(
      `INSERT INTO everdict_skill_versions (tenant, skill_id, version, name, description, instructions, files, refs, note, stamped_by, stamped_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant, skill_id, version) DO NOTHING
       RETURNING version`,
      [
        record.tenant,
        record.skillId,
        record.version,
        record.name,
        record.description,
        record.instructions,
        JSON.stringify(record.files),
        JSON.stringify(record.refs),
        record.note ?? null,
        record.stampedBy,
        record.stampedAt,
      ],
    );
    if (rows.length === 0) throw conflict(record);
  }

  // Ordered in SQL by stamp time (the index serves it), then re-sorted by semver so a hand-picked out-of-order
  // version still reads in version order — the panel's axis is the version, not the clock.
  async list(tenant: string, skillId: string): Promise<SkillVersionRecord[]> {
    const { rows } = await this.client.query<SkillVersionRow>(
      "SELECT * FROM everdict_skill_versions WHERE tenant=$1 AND skill_id=$2 ORDER BY stamped_at DESC",
      [tenant, skillId],
    );
    return rows.map(rowToRecord).sort(newestFirst);
  }

  async get(tenant: string, skillId: string, version: string): Promise<SkillVersionRecord | undefined> {
    const { rows } = await this.client.query<SkillVersionRow>(
      "SELECT * FROM everdict_skill_versions WHERE tenant=$1 AND skill_id=$2 AND version=$3",
      [tenant, skillId, version],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, skillId: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_skill_versions WHERE tenant=$1 AND skill_id=$2", [tenant, skillId]);
  }
}
