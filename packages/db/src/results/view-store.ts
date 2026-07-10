import { type ViewRecord, ViewRecordSchema } from "@everdict/contracts";

import type { SqlClient } from "../client.js";

// Record schemas now live in contracts/records — re-architecture P0c; db keeps compat re-exports (removed in the P4 sweep).
export { type ViewRecord, ViewRecordSchema, type ViewVisibility, ViewVisibilitySchema } from "@everdict/contracts";

// Workspace (tenant) scoped. listVisible = my private + workspace-shared (others' private are not visible).
export interface ViewStore {
  create(record: ViewRecord): Promise<void>;
  get(tenant: string, id: string): Promise<ViewRecord | undefined>;
  listVisible(tenant: string, subject: string): Promise<ViewRecord[]>;
  update(tenant: string, id: string, patch: Partial<ViewRecord>): Promise<ViewRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}

export class InMemoryViewStore implements ViewStore {
  private readonly byId = new Map<string, ViewRecord>();

  async create(record: ViewRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<ViewRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined; // treat another workspace's as nonexistent
  }

  async listVisible(tenant: string, subject: string): Promise<ViewRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && (r.visibility === "workspace" || r.createdBy === subject))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(tenant: string, id: string, patch: Partial<ViewRecord>): Promise<ViewRecord | undefined> {
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

interface ViewRow {
  id: string;
  tenant: string;
  name: string;
  config: unknown;
  visibility: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: ViewRow): ViewRecord {
  return ViewRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    config: row.config,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres view store — same contract as in-memory. config is jsonb.
export class PgViewStore implements ViewStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ViewRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_views (id, tenant, name, config, visibility, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        record.id,
        record.tenant,
        record.name,
        JSON.stringify(record.config ?? null),
        record.visibility,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async get(tenant: string, id: string): Promise<ViewRecord | undefined> {
    const { rows } = await this.client.query<ViewRow>("SELECT * FROM everdict_views WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listVisible(tenant: string, subject: string): Promise<ViewRecord[]> {
    const { rows } = await this.client.query<ViewRow>(
      `SELECT * FROM everdict_views
       WHERE tenant=$1 AND (visibility='workspace' OR created_by=$2)
       ORDER BY created_at DESC`,
      [tenant, subject],
    );
    return rows.map(rowToRecord);
  }

  async update(tenant: string, id: string, patch: Partial<ViewRecord>): Promise<ViewRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: ViewRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    await this.client.query(
      "UPDATE everdict_views SET name=$3, config=$4, visibility=$5, updated_at=$6 WHERE tenant=$1 AND id=$2",
      [tenant, id, next.name, JSON.stringify(next.config ?? null), next.visibility, next.updatedAt],
    );
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_views WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
