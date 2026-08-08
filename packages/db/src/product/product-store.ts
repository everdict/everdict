import type { OutboxEvent, ProductListFilter, ProductStore } from "@everdict/application-control";
import { type ProductRecord, ProductRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "../tracker/row.js";

export class InMemoryProductStore implements ProductStore {
  private readonly byId = new Map<string, ProductRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: ProductRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<ProductRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async list(tenant: string, filter?: ProductListFilter): Promise<ProductRecord[]> {
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
  ): Promise<ProductRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next: ProductRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
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

interface ProductRow extends TrackerRow {
  name: string;
  description: string | null;
  icon: string | null;
  services: unknown;
  series: unknown;
  auto_eval: unknown;
}

const PRODUCT_COLUMNS =
  "(id, tenant, name, description, icon, services, series, auto_eval, history, created_by, created_at, updated_at)";
const PRODUCT_VALUES = "($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::timestamptz,$12::timestamptz)";

function insertParams(record: ProductRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.name,
    record.description ?? null,
    record.icon ?? null,
    JSON.stringify(record.services),
    JSON.stringify(record.series),
    JSON.stringify(record.autoEval),
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
  ];
}

function rowToRecord(row: ProductRow): ProductRecord {
  return ProductRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.icon !== null ? { icon: row.icon } : {}),
    services: Array.isArray(row.services) ? row.services : [],
    series: Array.isArray(row.series) ? row.series : [],
    ...(row.auto_eval !== null && typeof row.auto_eval === "object" ? { autoEval: row.auto_eval } : {}),
    history: trackerHistory(row.history),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PgProductStore implements ProductStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ProductRecord, events?: OutboxEvent[]): Promise<void> {
    const base = insertParams(record);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_products ${PRODUCT_COLUMNS} VALUES ${PRODUCT_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_products ${PRODUCT_COLUMNS} VALUES ${PRODUCT_VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<ProductRecord | undefined> {
    const { rows } = await this.client.query<ProductRow>("SELECT * FROM everdict_products WHERE tenant=$1 AND id=$2", [
      tenant,
      id,
    ]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async list(tenant: string, filter?: ProductListFilter): Promise<ProductRecord[]> {
    const params: unknown[] = [tenant];
    let sql = "SELECT * FROM everdict_products WHERE tenant = $1 ORDER BY updated_at DESC";
    if (filter?.limit !== undefined) {
      sql += " LIMIT $2";
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<ProductRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
  ): Promise<ProductRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: ProductRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    const sets = `name=$3, description=$4, icon=$5, services=$6::jsonb, series=$7::jsonb,
       auto_eval=$8::jsonb, history=$9::jsonb, updated_at=$10::timestamptz`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.icon ?? null,
      JSON.stringify(next.services),
      JSON.stringify(next.series),
      JSON.stringify(next.autoEval),
      JSON.stringify(next.history),
      next.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<ProductRow>(
        `WITH upd AS (UPDATE everdict_products SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<ProductRow>(
      `UPDATE everdict_products SET ${sets} WHERE tenant=$1 AND id=$2 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_products WHERE tenant=$1 AND id=$2", [tenant, id]);
  }
}
