import type { OutboxEvent, ProjectListFilter, ProjectStore, ProjectUpdateStore } from "@everdict/application-control";
import {
  type ProjectRecord,
  ProjectRecordSchema,
  type ProjectUpdateRecord,
  ProjectUpdateRecordSchema,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory, trackerIds } from "./row.js";

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
          (filter?.initiativeId === undefined || record.initiativeIds.includes(filter.initiativeId)) &&
          (filter?.initiativeIds === undefined ||
            record.initiativeIds.some((id) => filter.initiativeIds?.includes(id) === true)) &&
          (filter?.teamId === undefined || record.teamIds.includes(filter.teamId)),
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
  team_ids: unknown;
  initiative_ids: unknown;
  lead: string | null;
  member_ids: unknown;
  health: string | null;
  milestones: unknown;
  target_date: string | null;
  completed_at: string | Date | null;
}

const PROJECT_COLUMNS =
  "(id, tenant, name, description, status, team_ids, initiative_ids, lead, member_ids, health, milestones, target_date, completed_at, history, created_by, created_at, updated_at)";
const PROJECT_VALUES =
  "($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,$12,$13::timestamptz,$14::jsonb,$15,$16::timestamptz,$17::timestamptz)";

function insertParams(record: ProjectRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.name,
    record.description ?? null,
    record.status,
    JSON.stringify(record.teamIds),
    JSON.stringify(record.initiativeIds),
    record.lead ?? null,
    JSON.stringify(record.memberIds),
    record.health ?? null,
    JSON.stringify(record.milestones),
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
    teamIds: trackerIds(row.team_ids),
    initiativeIds: trackerIds(row.initiative_ids),
    ...(row.lead !== null ? { lead: row.lead } : {}),
    memberIds: trackerIds(row.member_ids),
    ...(row.health !== null ? { health: row.health } : {}),
    milestones: Array.isArray(row.milestones) ? row.milestones : [],
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
    // Containment over the jsonb lists (GIN-indexed in migration 0108) — a project belongs to every initiative
    // and every team it names, so both filters are `@>`, never an equality on a scalar column.
    if (filter?.initiativeId !== undefined) {
      conds.push(`initiative_ids @> $${i++}::jsonb`);
      params.push(JSON.stringify([filter.initiativeId]));
    }
    if (filter?.initiativeIds !== undefined) {
      // `?|` = "shares any element with", which is the roll-up's question: does this project belong to the
      // initiative or to any of its descendants.
      conds.push(`initiative_ids ?| $${i++}::text[]`);
      params.push(filter.initiativeIds);
    }
    if (filter?.teamId !== undefined) {
      conds.push(`team_ids @> $${i++}::jsonb`);
      params.push(JSON.stringify([filter.teamId]));
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
    const sets = `name=$3, description=$4, status=$5, team_ids=$6::jsonb, initiative_ids=$7::jsonb,
       lead=$8, member_ids=$9::jsonb, health=$10, milestones=$11::jsonb,
       target_date=$12, completed_at=$13::timestamptz, history=$14::jsonb, updated_at=$15::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.status,
      JSON.stringify(next.teamIds),
      JSON.stringify(next.initiativeIds),
      next.lead ?? null,
      JSON.stringify(next.memberIds),
      next.health ?? null,
      JSON.stringify(next.milestones),
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

// --- The posted updates -------------------------------------------------------------------------------------
// Append-only: an update is what somebody said at a moment, so there is no edit path and nothing to invalidate.

export class InMemoryProjectUpdateStore implements ProjectUpdateStore {
  private readonly rows: ProjectUpdateRecord[] = [];

  async create(record: ProjectUpdateRecord): Promise<void> {
    this.rows.push(record);
  }

  async list(tenant: string, projectId: string, limit?: number): Promise<ProjectUpdateRecord[]> {
    const rows = this.rows
      .filter((row) => row.tenant === tenant && row.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

interface ProjectUpdateRow {
  id: string;
  tenant: string;
  project_id: string;
  health: string;
  body: string;
  created_by: string;
  created_at: string | Date;
}

export class PgProjectUpdateStore implements ProjectUpdateStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ProjectUpdateRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_project_updates (id, tenant, project_id, health, body, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [record.id, record.tenant, record.projectId, record.health, record.body, record.createdBy, record.createdAt],
    );
  }

  async list(tenant: string, projectId: string, limit?: number): Promise<ProjectUpdateRecord[]> {
    const params: unknown[] = [tenant, projectId];
    let sql = `SELECT * FROM everdict_project_updates
       WHERE tenant=$1 AND project_id=$2 ORDER BY created_at DESC`;
    if (limit !== undefined) {
      sql += " LIMIT $3";
      params.push(limit);
    }
    const { rows } = await this.client.query<ProjectUpdateRow>(sql, params);
    return rows.map((row) =>
      ProjectUpdateRecordSchema.parse({
        id: row.id,
        tenant: row.tenant,
        projectId: row.project_id,
        health: row.health,
        body: row.body,
        createdBy: row.created_by,
        createdAt: iso(row.created_at),
      }),
    );
  }
}
