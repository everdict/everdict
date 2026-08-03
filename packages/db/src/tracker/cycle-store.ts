import type { CycleListFilter, CycleStore, OutboxEvent } from "@everdict/application-control";
import { type CycleRecord, CycleRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "./row.js";

// A team's iterations — same contract in-memory and on Postgres. Ordered by NUMBER, not by timestamp: cycles
// are a sequence a team counts, and "the most recent one" means the highest number even when two were planned
// in the same minute.

function matchesFilter(record: CycleRecord, filter: CycleListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.teamId !== undefined && record.teamId !== filter.teamId) return false;
  if (filter.open === true && record.completedAt !== undefined) return false;
  return true;
}

export class InMemoryCycleStore implements CycleStore {
  private readonly byId = new Map<string, CycleRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: CycleRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<CycleRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async list(tenant: string, filter?: CycleListFilter): Promise<CycleRecord[]> {
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant && matchesFilter(record, filter))
      .sort((a, b) => b.number - a.number);
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<CycleRecord>,
    events?: OutboxEvent[],
  ): Promise<CycleRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: CycleRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
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

interface CycleRow extends TrackerRow {
  team_id: string;
  number: number;
  name: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  completed_at: string | Date | null;
}

const CYCLE_COLUMNS =
  "(id, tenant, team_id, number, name, description, starts_at, ends_at, completed_at, history, created_by, created_at, updated_at)";
const CYCLE_VALUES = "($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb,$11,$12::timestamptz,$13::timestamptz)";

function insertParams(record: CycleRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.teamId,
    record.number,
    record.name ?? null,
    record.description ?? null,
    record.startsAt,
    record.endsAt,
    record.completedAt ?? null,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: CycleRow): CycleRecord {
  return CycleRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    teamId: row.team_id,
    number: row.number,
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    ...(row.completed_at !== null ? { completedAt: iso(row.completed_at) } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgCycleStore implements CycleStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: CycleRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_cycles ${CYCLE_COLUMNS} VALUES ${CYCLE_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_cycles ${CYCLE_COLUMNS} VALUES ${CYCLE_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<CycleRecord | undefined> {
    const { rows } = await this.client.query<CycleRow>("SELECT * FROM everdict_cycles WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: CycleListFilter): Promise<CycleRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (filter?.teamId !== undefined) {
      conds.push(`team_id = $${i++}`);
      params.push(filter.teamId);
    }
    // "Open" is the absence of an explicit close, never a date comparison: a cycle whose end date passed but
    // which nobody closed is a cycle somebody forgot, and the planning screen has to keep showing it.
    if (filter?.open === true) conds.push("completed_at IS NULL");
    let sql = `SELECT * FROM everdict_cycles WHERE ${conds.join(" AND ")} ORDER BY number DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<CycleRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<CycleRecord>,
    events?: OutboxEvent[],
  ): Promise<CycleRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: CycleRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const sets = `name=$3, description=$4, starts_at=$5, ends_at=$6, completed_at=$7::timestamptz,
       history=$8::jsonb, updated_at=$9::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.name ?? null,
      next.description ?? null,
      next.startsAt,
      next.endsAt,
      next.completedAt ?? null,
      JSON.stringify(next.history),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<CycleRow>(
        `WITH upd AS (UPDATE everdict_cycles SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<CycleRow>(
      `UPDATE everdict_cycles SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_cycles WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
