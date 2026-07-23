import { type SkillRecord, SkillRecordSchema } from "@everdict/contracts";

import type { SkillStore } from "@everdict/application-control";

import type { SqlClient } from "../client.js";

// Workspace Skills — SKILL.md-style procedures the members author (dual-scoped private|workspace). `list` returns every
// workspace skill in the tenant plus the caller's own private ones (the manage gate is per-visibility, in the service).
// Same contract, InMemory (dev/tests) + Pg (DATABASE_URL). Mirrors the browser-profile store.
export class InMemorySkillStore implements SkillStore {
  private readonly byId = new Map<string, SkillRecord>();

  async create(record: SkillRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<SkillRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // another workspace's is nonexistent
  }

  async list(tenant: string, subject: string): Promise<SkillRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && (r.visibility === "workspace" || r.createdBy === subject))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(tenant: string, id: string, patch: Partial<SkillRecord>): Promise<SkillRecord | undefined> {
    const r = this.byId.get(id);
    if (!r || r.tenant !== tenant) return undefined;
    const next = { ...r, ...patch, id: r.id, tenant: r.tenant };
    this.byId.set(id, next);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const r = this.byId.get(id);
    if (r && r.tenant === tenant) this.byId.delete(id);
  }
}

interface SkillRow {
  id: string;
  tenant: string;
  name: string;
  description: string;
  instructions: string;
  visibility: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: SkillRow): SkillRecord {
  return SkillRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres skill store — same contract as in-memory.
export class PgSkillStore implements SkillStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: SkillRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_skills (id, tenant, name, description, instructions, visibility, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.id,
        record.tenant,
        record.name,
        record.description,
        record.instructions,
        record.visibility,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<SkillRecord | undefined> {
    const { rows } = await this.client.query<SkillRow>("SELECT * FROM everdict_skills WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, subject: string): Promise<SkillRecord[]> {
    const { rows } = await this.client.query<SkillRow>(
      `SELECT * FROM everdict_skills
       WHERE tenant=$1 AND (visibility='workspace' OR created_by=$2)
       ORDER BY created_at DESC`,
      [tenant, subject],
    );
    return rows.map(rowToRecord);
  }

  async update(tenant: string, id: string, patch: Partial<SkillRecord>): Promise<SkillRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: SkillRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    await this.client.query(
      "UPDATE everdict_skills SET name=$3, description=$4, instructions=$5, visibility=$6, updated_at=$7 WHERE tenant=$1 AND id=$2",
      [tenant, id, next.name, next.description, next.instructions, next.visibility, next.updatedAt],
    );
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_skills WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
