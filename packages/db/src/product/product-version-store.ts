import type { OutboxEvent, ProductVersionListFilter, ProductVersionStore } from "@everdict/application-control";
import { type ProductServiceVersionRecord, ProductServiceVersionRecordSchema } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { assertInsertArity, insertPlaceholders } from "../insert-columns.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { iso } from "../tracker/row.js";

// The imported version ledger. Insert-once by the natural key (tenant, productId, service, version): `create`
// returns whether the row actually landed, and the outbox events ride ONLY an actual insert — so a re-sync or
// two racing sweeps can never make one version news twice. That invariant lives HERE (ON CONFLICT DO NOTHING
// feeding the events CTE) rather than in the service, because a read-then-write check would race.

// The insert-once identity (mig 0155): the STREAM, not just the service's display name. Repointing a service
// at a different repository means the name now tracks different versions — which is exactly why the domain
// clears its watermark — so keying on the name alone made the new stream's v1.0.0 collide with the old
// stream's and vanish as "already known". See the contract's `streamKey`.
function naturalKey(
  record: Pick<ProductServiceVersionRecord, "tenant" | "productId" | "service" | "version" | "streamKey">,
): string {
  // A canonical tuple, not a delimiter join: these are user-supplied strings, and joining them on any
  // character invents a collision vocabulary the caller never agreed to.
  return JSON.stringify([record.tenant, record.productId, record.service, record.streamKey ?? "", record.version]);
}

export class InMemoryProductVersionStore implements ProductVersionStore {
  private readonly byKey = new Map<string, ProductServiceVersionRecord>();
  private readonly events: OutboxEvent[] = [];

  async create(record: ProductServiceVersionRecord, events?: OutboxEvent[]): Promise<boolean> {
    const key = naturalKey(record);
    // ADOPT a legacy row (no stream) into the stream now importing it — the Pg twin's UPDATE-then-INSERT.
    // Without it the first sync after mig 0155 would re-import all of history AS NEWS.
    if (record.streamKey !== undefined) {
      const legacy = naturalKey({ ...record, streamKey: "" });
      const prior = this.byKey.get(legacy);
      if (prior !== undefined) {
        this.byKey.delete(legacy);
        this.byKey.set(key, { ...prior, streamKey: record.streamKey });
        return false; // adopted, not news — it was already on the timeline
      }
    }
    if (this.byKey.has(key)) return false;
    this.byKey.set(key, record);
    if (events) this.events.push(...events);
    return true;
  }

  async list(tenant: string, filter: ProductVersionListFilter): Promise<ProductServiceVersionRecord[]> {
    const rows = [...this.byKey.values()]
      .filter(
        (record) =>
          record.tenant === tenant &&
          record.productId === filter.productId &&
          (filter.service === undefined || record.service === filter.service) &&
          (filter.streamKey === undefined || (record.streamKey ?? "") === filter.streamKey),
      )
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return filter.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  async removeForProduct(tenant: string, productId: string): Promise<void> {
    this.removeAllForProduct(tenant, productId);
  }

  // The in-memory half of the product's atomic cascade (see PgProductStore.removeAggregate) — synchronous, so
  // the composition can perform the whole aggregate delete in one turn, which is this pair's equivalent of
  // the single statement Postgres runs.
  removeAllForProduct(tenant: string, productId: string): number {
    let removed = 0;
    for (const [key, record] of [...this.byKey.entries()]) {
      if (record.tenant === tenant && record.productId === productId) {
        this.byKey.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  emittedEvents(): OutboxEvent[] {
    return [...this.events];
  }
}

interface ProductVersionRow {
  id: string;
  tenant: string;
  product_id: string;
  service: string;
  version: string;
  stream_key?: string | null;
  kind: string;
  prerelease: boolean;
  sha: string | null;
  url: string | null;
  notes: string | null;
  published_at: string | Date;
  imported_at: string | Date;
}

const VERSION_COLUMNS =
  "(id, tenant, product_id, service, version, stream_key, kind, prerelease, sha, url, notes, published_at, imported_at)";
const VERSION_VALUES = insertPlaceholders(VERSION_COLUMNS);
// Insert-once WITHOUT naming a target (arch-review 14 P0). Naming the stream-scoped index made the writer
// depend on a uniqueness that is not yet the only one in force: mig 0138's original
// UNIQUE (tenant, product_id, service, version) is still present for rollback safety, so a second stream's
// same version violates THAT constraint — which a targeted ON CONFLICT does not absorb, so the insert raised
// instead of being skipped.
//
// Target-less DO NOTHING is correct under BOTH schemas, which is what makes a rolling deploy safe: while the
// legacy constraint stands, a second stream's same version is quietly treated as already-known (exactly the
// pre-0155 behaviour); once mig 0157 drops it, only the stream-scoped index applies and the row lands. The
// writer needs no flag and no coordination — it is compatible in both directions, which is the property an
// expand/contract rollout actually requires.

function insertParams(record: ProductServiceVersionRecord): unknown[] {
  return [
    record.id,
    record.tenant,
    record.productId,
    record.service,
    record.version,
    record.streamKey ?? "",
    record.kind,
    record.prerelease,
    record.sha ?? null,
    record.url ?? null,
    record.notes ?? null,
    record.publishedAt,
    record.importedAt,
  ];
}

function rowToRecord(row: ProductVersionRow): ProductServiceVersionRecord {
  return ProductServiceVersionRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    productId: row.product_id,
    service: row.service,
    version: row.version,
    ...(row.stream_key ? { streamKey: row.stream_key } : {}),
    kind: row.kind,
    prerelease: row.prerelease,
    ...(row.sha !== null ? { sha: row.sha } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.notes !== null ? { notes: row.notes } : {}),
    publishedAt: iso(row.published_at),
    importedAt: iso(row.imported_at),
  });
}

const ON_CONFLICT = "ON CONFLICT DO NOTHING";

export class PgProductVersionStore implements ProductVersionStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: ProductServiceVersionRecord, events?: OutboxEvent[]): Promise<boolean> {
    // ADOPT before inserting (mig 0155): a row still carrying the empty legacy stream is claimed by the
    // stream now importing it, which is exactly what the old name-only key meant. Without this the first
    // sync after the migration would find no conflict for any historical version and re-import the lot AS
    // NEWS — events and auto-evaluations for years-old releases, the storm the backfill rule exists to
    // prevent. Idempotent, and it converges after one sync per service.
    if (record.streamKey !== undefined && record.streamKey !== "") {
      const adopted = await this.client.query<{ id: string }>(
        `UPDATE everdict_product_service_versions SET stream_key = $5
         WHERE tenant = $1 AND product_id = $2 AND service = $3 AND version = $4 AND stream_key = ''
         RETURNING id`,
        [record.tenant, record.productId, record.service, record.version, record.streamKey],
      );
      // Adopted rows were already on the timeline — known, therefore never news.
      if (adopted.rows.length > 0) return false;
    }
    const base = insertParams(record);
    assertInsertArity("product-version-store.create", VERSION_COLUMNS, base);
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      const { rows } = await this.client.query<{ id: string }>(
        `WITH ins AS (INSERT INTO everdict_product_service_versions ${VERSION_COLUMNS} VALUES ${VERSION_VALUES}
                      ${ON_CONFLICT} RETURNING id),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM ins))
         SELECT id FROM ins`,
        [...base, ...ev.params],
      );
      return rows.length > 0;
    }
    const { rows } = await this.client.query<{ id: string }>(
      `INSERT INTO everdict_product_service_versions ${VERSION_COLUMNS} VALUES ${VERSION_VALUES}
       ${ON_CONFLICT} RETURNING id`,
      base,
    );
    return rows.length > 0;
  }

  async list(tenant: string, filter: ProductVersionListFilter): Promise<ProductServiceVersionRecord[]> {
    const conds = ["tenant = $1", "product_id = $2"];
    const params: unknown[] = [tenant, filter.productId];
    let i = 3;
    if (filter.streamKey !== undefined) {
      conds.push(`coalesce(stream_key, '') = $${i++}`);
      params.push(filter.streamKey);
    }
    if (filter.service !== undefined) {
      conds.push(`service = $${i++}`);
      params.push(filter.service);
    }
    let sql = `SELECT * FROM everdict_product_service_versions WHERE ${conds.join(" AND ")} ORDER BY published_at DESC`;
    if (filter.limit !== undefined) {
      sql += ` LIMIT $${i++}`;
      params.push(filter.limit);
    }
    const { rows } = await this.client.query<ProductVersionRow>(sql, params);
    return rows.map(rowToRecord);
  }

  async removeForProduct(tenant: string, productId: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_product_service_versions WHERE tenant=$1 AND product_id=$2", [
      tenant,
      productId,
    ]);
  }
}
