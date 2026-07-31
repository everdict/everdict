import type { OutboxEvent, ProjectListFilter, ProjectStore } from "@everdict/application-control";
import { type ProjectRecord, ProjectRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "./row.js";

export class InMemoryProjectStore implements ProjectStore {
  private readonly byId = new Map<string, ProjectRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: ProjectRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<ProjectRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]> {
    const rows = [...this.byId.values()]
      .filter(
        (record) =>
          record.tenant === tenant &&
          (filter?.status === undefined || record.status === filter.status) &&
          (filter?.initiativeId === undefined || record.initiativeId === filter.initiativeId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProjectRecord>,
    events?: OutboxEvent[],
  ): Promise<ProjectRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: ProjectRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) this.byId.delete(id);
  }

  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface ProjectRow extends TrackerRow {
  name: string;
  description: string | null;
  status: string;
  initiative_id: string | null;
  target_date: string | null;
  completed_at: string | Date | null;
}

const PROJECT_COLUMNS =
  "(id, tenant, name, description, status, initiative_id, target_date, completed_at, history, created_by, created_at, updated_at)";
const PROJECT_VALUES = "($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10,$11::timestamptz,$12::timestamptz)";

function insertParams(record: ProjectRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.name,
    record.description ?? null,
    record.status,
    record.initiativeId ?? null,
    record.targetDate ?? null,
    record.completedAt ?? null,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return ProjectRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.initiative_id !== null ? { initiativeId: row.initiative_id } : {}),
    ...(row.target_date !== null ? { targetDate: row.target_date } : {}),
    ...(row.completed_at !== null ? { completedAt: iso(row.completed_at) } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgProjectStore implements ProjectStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ProjectRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_projects ${PROJECT_COLUMNS} VALUES ${PROJECT_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_projects ${PROJECT_COLUMNS} VALUES ${PROJECT_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<ProjectRecord | undefined> {
    const { rows } = await this.client.query<ProjectRow>("SELECT * FROM everdict_projects WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (filter?.status !== undefined) {
      conds.push(`status = $${i++}`);
      params.push(filter.status);
    }
    if (filter?.initiativeId !== undefined) {
      conds.push(`initiative_id = $${i++}`);
      params.push(filter.initiativeId);
    }
    let sql = `SELECT * FROM everdict_projects WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<ProjectRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProjectRecord>,
    events?: OutboxEvent[],
  ): Promise<ProjectRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: ProjectRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const sets = `name=$3, description=$4, status=$5, initiative_id=$6, target_date=$7,
       completed_at=$8::timestamptz, history=$9::jsonb, updated_at=$10::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.status,
      next.initiativeId ?? null,
      next.targetDate ?? null,
      next.completedAt ?? null,
      JSON.stringify(next.history),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<ProjectRow>(
        `WITH upd AS (UPDATE everdict_projects SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<ProjectRow>(
      `UPDATE everdict_projects SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_projects WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
