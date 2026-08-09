import type { OutboxEvent, ReleaseListFilter, ReleaseStore } from "@everdict/application-control";
import { type ReleaseRecord, ReleaseRecordSchema, type ReleaseStatus } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory, trackerIds } from "../tracker/row.js";

export class InMemoryReleaseStore implements ReleaseStore {
  private readonly byId = new Map<string, ReleaseRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: ReleaseRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<ReleaseRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async list(tenant: string, filter?: ReleaseListFilter): Promise<ReleaseRecord[]> {
    const rows = [...this.byId.values()]
      .filter(
        (record) =>
          record.tenant === tenant &&
          (filter?.productId === undefined || record.productId === filter.productId) &&
          (filter?.status === undefined || record.status === filter.status),
      )
      // Newest plan first — the same order the timeline draws (targetDate is optional, so creation time is
      // the one ordering every release has).
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ReleaseRecord>,
    events?: OutboxEvent[],
    guard?: { expectStatus?: ReleaseStatus; expectVersion?: number },
  ): Promise<ReleaseRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    // Terminal-race guard: the aggregate decided from the status it READ, so the write commits only from
    // that status. Otherwise two legal decisions (released / cancelled) both pass the domain and the last
    // writer wins — with the loser's fact already in the outbox.
    if (guard?.expectStatus !== undefined && current.status !== guard.expectStatus) return undefined;
    // The aggregate version catches a concurrent EDIT, which a status guard cannot see.
    if (guard?.expectVersion !== undefined && (current.version ?? 0) !== guard.expectVersion) return undefined;
    const next0 = { ...current, ...patch, version: (current.version ?? 0) + 1 };
    const next: ReleaseRecord = { ...next0, id: current.id, tenant: current.tenant };
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

interface ReleaseRow extends TrackerRow {
  version?: number | string | null; // bigint arrives as a string from pg
  product_id: string;
  name: string;
  description: string | null;
  status: string;
  target_date: string | null;
  released_at: string | Date | null;
  series_keys: unknown;
}

const RELEASE_COLUMNS =
  "(id, tenant, product_id, name, description, status, target_date, released_at, series_keys, history, created_by, created_at, updated_at)";
const RELEASE_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10::jsonb,$11,$12::timestamptz,$13::timestamptz)";

function insertParams(record: ReleaseRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.productId,
    record.name,
    record.description ?? null,
    record.status,
    record.targetDate ?? null,
    record.releasedAt ?? null,
    record.seriesKeys !== undefined ? JSON.stringify(record.seriesKeys) : null,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: ReleaseRow): ReleaseRecord {
  return ReleaseRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    productId: row.product_id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.version !== null && row.version !== undefined ? { version: Number(row.version) } : {}),
    ...(row.target_date !== null ? { targetDate: row.target_date } : {}),
    ...(row.released_at !== null ? { releasedAt: iso(row.released_at) } : {}),
    // NULL = "every series" — a real absence, not an empty selection, so it must not become [].
    ...(row.series_keys !== null ? { seriesKeys: trackerIds(row.series_keys) } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgReleaseStore implements ReleaseStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ReleaseRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_product_releases ${RELEASE_COLUMNS} VALUES ${RELEASE_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_product_releases ${RELEASE_COLUMNS} VALUES ${RELEASE_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<ReleaseRecord | undefined> {
    const { rows } = await this.client.query<ReleaseRow>(
      "SELECT * FROM everdict_product_releases WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: ReleaseListFilter): Promise<ReleaseRecord[]> {
    const conds = ["tenant = $1"];
    const params: unknown[] = [tenant];
    let i = 2;
    if (filter?.productId !== undefined) {
      conds.push(`product_id = $${i++}`);
      params.push(filter.productId);
    }
    if (filter?.status !== undefined) {
      conds.push(`status = $${i++}`);
      params.push(filter.status);
    }
    let sql = `SELECT * FROM everdict_product_releases WHERE ${conds.join(" AND ")} ORDER BY created_at DESC`;
    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<ReleaseRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ReleaseRecord>,
    events?: OutboxEvent[],
    guard?: { expectStatus?: ReleaseStatus; expectVersion?: number },
  ): Promise<ReleaseRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: ReleaseRecord = {
      ...current,
      ...patch,
      id: current.id,
      tenant: current.tenant,
      version: (current.version ?? 0) + 1,
    };
    const sets = `name=$3, description=$4, status=$5, target_date=$6, released_at=$7::timestamptz,
       series_keys=$8::jsonb, history=$9::jsonb, updated_at=$10::timestamptz, version=$11`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.status,
      next.targetDate ?? null,
      next.releasedAt ?? null,
      next.seriesKeys !== undefined ? JSON.stringify(next.seriesKeys) : null,
      JSON.stringify(next.history),
      next.updatedAt,
      next.version ?? 0,
    ];
    // …and the status the caller decided FROM, as a WHERE condition — the read above is not the guarantee,
    // this is. A miss matches zero rows and the facts (WHERE EXISTS on the updating CTE) never land either.
    let guardSql = "";
    if (guard?.expectStatus !== undefined) {
      params.push(guard.expectStatus);
      guardSql += ` AND status=$${params.length}`;
    }
    if (guard?.expectVersion !== undefined) {
      params.push(guard.expectVersion);
      guardSql += ` AND coalesce(version, 0)=$${params.length}`;
    }
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<ReleaseRow>(
        `WITH upd AS (UPDATE everdict_product_releases SET ${sets} WHERE tenant=$1 AND id=$2${guardSql} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<ReleaseRow>(
      `UPDATE everdict_product_releases SET ${sets} WHERE tenant=$1 AND id=$2${guardSql} RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_product_releases WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
