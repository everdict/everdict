import type {
  InitiativeListFilter,
  InitiativeStore,
  InitiativeUpdateStore,
  OutboxEvent,
} from "@everdict/application-control";
import {
  type InitiativeRecord,
  InitiativeRecordSchema,
  type InitiativeUpdateRecord,
  InitiativeUpdateRecordSchema,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "./row.js";

export class InMemoryInitiativeStore implements InitiativeStore {
  private readonly byId = new Map<string, InitiativeRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: InitiativeRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<InitiativeRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async list(tenant: string, filter?: InitiativeListFilter): Promise<InitiativeRecord[]> {
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant && (filter?.status === undefined || record.status === filter.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<InitiativeRecord>,
    events?: OutboxEvent[],
  ): Promise<InitiativeRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: InitiativeRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
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

interface InitiativeRow extends TrackerRow {
  name: string;
  description: string | null;
  status: string;
  parent_id: string | null;
  lead: string | null;
  health: string | null;
  target_date: string | null;
  completed_at: string | Date | null;
}

const INITIATIVE_COLUMNS =
  "(id, tenant, name, description, status, parent_id, lead, health, target_date, completed_at, history, created_by, created_at, updated_at)";
const INITIATIVE_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::jsonb,$12,$13::timestamptz,$14::timestamptz)";

function insertParams(record: InitiativeRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.name,
    record.description ?? null,
    record.status,
    record.parentId ?? null,
    record.lead ?? null,
    record.health ?? null,
    record.targetDate ?? null,
    record.completedAt ?? null,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: InitiativeRow): InitiativeRecord {
  return InitiativeRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    ...(row.lead !== null ? { lead: row.lead } : {}),
    ...(row.health !== null ? { health: row.health } : {}),
    ...(row.target_date !== null ? { targetDate: row.target_date } : {}),
    ...(row.completed_at !== null ? { completedAt: iso(row.completed_at) } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgInitiativeStore implements InitiativeStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: InitiativeRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_initiatives ${INITIATIVE_COLUMNS} VALUES ${INITIATIVE_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_initiatives ${INITIATIVE_COLUMNS} VALUES ${INITIATIVE_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<InitiativeRecord | undefined> {
    const { rows } = await this.client.query<InitiativeRow>(
      "SELECT * FROM everdict_initiatives WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: InitiativeListFilter): Promise<InitiativeRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (filter?.status !== undefined) {
      conds.push(`status = $${i++}`);
      params.push(filter.status);
    }
    let sql = `SELECT * FROM everdict_initiatives WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<InitiativeRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<InitiativeRecord>,
    events?: OutboxEvent[],
  ): Promise<InitiativeRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: InitiativeRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const sets = `name=$3, description=$4, status=$5, parent_id=$6, lead=$7, health=$8,
       target_date=$9, completed_at=$10::timestamptz, history=$11::jsonb, updated_at=$12::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.status,
      next.parentId ?? null,
      next.lead ?? null,
      next.health ?? null,
      next.targetDate ?? null,
      next.completedAt ?? null,
      JSON.stringify(next.history),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<InitiativeRow>(
        `WITH upd AS (UPDATE everdict_initiatives SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<InitiativeRow>(
      `UPDATE everdict_initiatives SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_initiatives WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}

// --- The posted updates -------------------------------------------------------------------------------------
// Append-only, the same shape the project's timeline has: an update is what somebody said at a moment, so there
// is no edit path and nothing to invalidate.

export class InMemoryInitiativeUpdateStore implements InitiativeUpdateStore {
  private readonly rows: InitiativeUpdateRecord[] = [];

  async create(record: InitiativeUpdateRecord): Promise<void> {
    this.rows.push(record);
  }

  async list(tenant: string, initiativeId: string, limit?: number): Promise<InitiativeUpdateRecord[]> {
    const rows = this.rows
      .filter((row) => row.tenant === tenant && row.initiativeId === initiativeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

interface InitiativeUpdateRow {
  id: string;
  tenant: string;
  initiative_id: string;
  health: string;
  body: string;
  created_by: string;
  created_at: string | Date;
}

export class PgInitiativeUpdateStore implements InitiativeUpdateStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: InitiativeUpdateRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_initiative_updates (id, tenant, initiative_id, health, body, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [record.id, record.tenant, record.initiativeId, record.health, record.body, record.createdBy, record.createdAt],
    );
  }

  async list(tenant: string, initiativeId: string, limit?: number): Promise<InitiativeUpdateRecord[]> {
    const params: unknown[] = [tenant, initiativeId];
    let sql = `SELECT * FROM everdict_initiative_updates
       WHERE tenant=$1 AND initiative_id=$2 ORDER BY created_at DESC`;
    if (limit !== undefined) {
      sql += " LIMIT $3";
      params.push(limit);
    }
    const { rows } = await this.client.query<InitiativeUpdateRow>(sql, params);
    return rows.map((row) =>
      InitiativeUpdateRecordSchema.parse({
        id: row.id,
        tenant: row.tenant,
        initiativeId: row.initiative_id,
        health: row.health,
        body: row.body,
        createdBy: row.created_by,
        createdAt: iso(row.created_at),
      }),
    );
  }
}
