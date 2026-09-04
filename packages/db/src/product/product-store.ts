import type { OutboxEvent, ProductListFilter, ProductStore } from "@everdict/application-control";
import { type ProductRecord, ProductRecordSchema } from "@everdict/contracts";
import { productEvaluationDefinitionDigest, productReleasePolicyDigest } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { assertInsertArity, insertPlaceholders } from "../insert-columns.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory } from "../tracker/row.js";

export class InMemoryProductStore implements ProductStore {
  private readonly byId = new Map<string, ProductRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: ProductRecord, events?: OutboxEvent[]): Promise<void> {
    // Derived on write, exactly as the Pg twin does it — the release guard compares a STORED value, so an
    // in-memory pair that skipped it would let the guard pass on a policy it never actually recorded.
    this.byId.set(record.id, {
      ...record,
      releasePolicyDigest: productReleasePolicyDigest(record),
      evaluationDefinitionDigest: productEvaluationDefinitionDigest(record),
    });
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<ProductRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async getBySlug(tenant: string, slug: string): Promise<ProductRecord | undefined> {
    return [...this.byId.values()].find((record) => record.tenant === tenant && record.slug === slug);
  }

  async list(tenant: string, filter?: ProductListFilter): Promise<ProductRecord[]> {
    const rows = [...this.byId.values()]
      .filter((record) => record.tenant === tenant)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async listAll(limit?: number): Promise<ProductRecord[]> {
    const rows = [...this.byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
    guard?: { expectVersion?: number },
  ): Promise<ProductRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    // The aggregate's own optimistic guard — a whole-row rewrite from a stale snapshot reverts whatever the
    // other writer changed, and for a product that means silently re-opening a release gate.
    if (guard?.expectVersion !== undefined && (current.version ?? 0) !== guard.expectVersion) return undefined;
    // The version moves on EVERY write (mig 0150) — a release decision commits against the policy version it
    // read, and a policy edit must invalidate that decision even though it touches a different aggregate.
    const merged: ProductRecord = {
      ...current,
      ...patch,
      version: (current.version ?? 0) + 1,
      id: current.id,
      tenant: current.tenant,
    };
    const next: ProductRecord = {
      ...merged,
      releasePolicyDigest: productReleasePolicyDigest(merged),
      evaluationDefinitionDigest: productEvaluationDefinitionDigest(merged),
    };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }

  async remove(tenant: string, id: string): Promise<void> {
    const current = this.byId.get(id);
    if (current && current.tenant === tenant) this.byId.delete(id);
  }

  // The in-memory twin of the atomic cascade. One process, one turn — nothing can interleave, which is the
  // property the Pg statement buys with a single CTE. Children live in sibling stores here, so the
  // composition binds them (see attachChildren); unbound, this degrades to deleting the product alone, which
  // is exactly what a unit path that never created children needs.
  async removeAggregate(tenant: string, id: string): Promise<{ releases: number; versions: number }> {
    const counts = this.cascade?.(tenant, id) ?? { releases: 0, versions: 0 };
    await this.remove(tenant, id);
    return counts;
  }

  private cascade?: (tenant: string, productId: string) => { releases: number; versions: number };

  // Bind the child stores the aggregate owns, so the in-memory pair removes what the Pg statement removes.
  attachChildren(cascade: (tenant: string, productId: string) => { releases: number; versions: number }): void {
    this.cascade = cascade;
  }

  // Synchronous peek — the release decision's cross-aggregate policy guard needs the product's version at
  // the moment of the release write, and the Pg store answers that with a sub-select INSIDE the write
  // statement. Exposed so the in-memory pair gives the same answer without turning the guard into a read
  // that happens before the write (which is the window the guard exists to close).
  peek(id: string): ProductRecord | undefined {
    return this.byId.get(id);
  }

  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface ProductRow extends TrackerRow {
  version?: string | number | null;
  release_policy_digest?: string | null;
  evaluation_definition_digest?: string | null;
  slug?: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  services: unknown;
  series: unknown;
  auto_eval: unknown;
}

const PRODUCT_COLUMNS =
  "(id, tenant, slug, name, description, icon, services, series, auto_eval, history, created_by, created_at, updated_at, release_policy_digest, evaluation_definition_digest)";
const PRODUCT_VALUES = insertPlaceholders(PRODUCT_COLUMNS);

function insertParams(record: ProductRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.slug ?? null,
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
    // DERIVED here, never taken from the caller: the digest is a fact about the series being written, and a
    // record that could carry its own would let a writer disagree with what it stored.
    productReleasePolicyDigest(record),
    productEvaluationDefinitionDigest(record),
  ];
}

function rowToRecord(row: ProductRow): ProductRecord {
  return ProductRecordSchema.parse({
    version: Number(row.version ?? 0),
    ...(row.release_policy_digest ? { releasePolicyDigest: row.release_policy_digest } : {}),
    ...(row.evaluation_definition_digest ? { evaluationDefinitionDigest: row.evaluation_definition_digest } : {}),
    id: row.id,
    tenant: row.tenant,
    ...(row.slug ? { slug: row.slug } : {}),
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
    assertInsertArity("product-store.create", PRODUCT_COLUMNS, base);
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

  async getBySlug(tenant: string, slug: string): Promise<ProductRecord | undefined> {
    const { rows } = await this.client.query<ProductRow>(
      "SELECT * FROM everdict_products WHERE tenant=$1 AND slug=$2",
      [tenant, slug],
    );
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

  async listAll(limit?: number): Promise<ProductRecord[]> {
    const params: unknown[] = [];
    let sql = "SELECT * FROM everdict_products ORDER BY updated_at DESC";
    if (limit !== undefined) {
      sql += " LIMIT $1";
      params.push(limit);
    }
    const { rows } = await this.client.query<ProductRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async update(
    tenant: string,
    id: string,
    patch: Partial<ProductRecord>,
    events?: OutboxEvent[],
    guard?: { expectVersion?: number },
  ): Promise<ProductRecord | undefined> {
    const current = await this.get(tenant, id);
    if (!current) return undefined;
    const next: ProductRecord = { ...current, ...patch, id: current.id, tenant: current.tenant };
    // version = version + 1 on EVERY write (mig 0150) — see the in-memory twin. Computed by the DATABASE,
    // never read-then-written, so two concurrent policy edits cannot land on the same number.
    const sets = `name=$3, description=$4, icon=$5, services=$6::jsonb, series=$7::jsonb,
       auto_eval=$8::jsonb, history=$9::jsonb, updated_at=$10::timestamptz, version = version + 1,
       release_policy_digest=$11, evaluation_definition_digest=$12`;
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
      productReleasePolicyDigest(next),
      productEvaluationDefinitionDigest(next),
    ];
    // …evaluated IN the write statement, like every other guard in this codebase. Checked before the UPDATE
    // it would only widen the window it exists to close.
    let guardSql = "";
    if (guard?.expectVersion !== undefined) {
      params.push(guard.expectVersion);
      guardSql = ` AND coalesce(version, 0)=$${params.length}`;
    }
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, params.length + 1);
      const { rows } = await this.client.query<ProductRow>(
        `WITH upd AS (UPDATE everdict_products SET ${sets} WHERE tenant=$1 AND id=$2${guardSql} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...params, ...ev.params],
      );
      return rows[0] ? rowToRecord(rows[0]) : undefined;
    }
    const { rows } = await this.client.query<ProductRow>(
      `UPDATE everdict_products SET ${sets} WHERE tenant=$1 AND id=$2${guardSql} RETURNING *`,
      params,
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async remove(tenant: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_products WHERE tenant=$1 AND id=$2", [tenant, id]);
  }

  // The aggregate delete as ONE statement (arch-review 12 P1). A single statement is atomic in Postgres, so
  // there is no instant at which the product is gone but its releases are not — the window an
  // application-level walk left open, and the one a concurrent createRelease could insert an orphan into.
  // Data-modifying CTEs all see the same snapshot, which is what makes the three deletes one decision.
  async removeAggregate(tenant: string, id: string): Promise<{ releases: number; versions: number }> {
    const { rows } = await this.client.query<{ releases: string | number; versions: string | number }>(
      `WITH del_releases AS (
         DELETE FROM everdict_product_releases WHERE tenant=$1 AND product_id=$2 RETURNING 1
       ), del_versions AS (
         DELETE FROM everdict_product_service_versions WHERE tenant=$1 AND product_id=$2 RETURNING 1
       ), del_product AS (
         DELETE FROM everdict_products WHERE tenant=$1 AND id=$2 RETURNING 1
       )
       SELECT (SELECT count(*) FROM del_releases) AS releases,
              (SELECT count(*) FROM del_versions) AS versions`,
      [tenant, id],
    );
    const row = rows[0];
    return { releases: Number(row?.releases ?? 0), versions: Number(row?.versions ?? 0) };
  }
}
