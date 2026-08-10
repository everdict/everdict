import type { OutboxEvent, ReleaseListFilter, ReleaseStore } from "@everdict/application-control";
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_CATEGORY,
  type ReleaseRecord,
  ReleaseRecordSchema,
  type ReleaseStatus,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { type TrackerRow, iso, trackerHistory, trackerIds } from "../tracker/row.js";

// The statuses readiness counts as OPEN — derived from the same category map the services use, never a
// hand-listed copy: a new status added to one list and not the other would silently change what "blocking"
// means at exactly the boundary this fence exists to hold.
const OPEN_ISSUE_STATUSES = ISSUE_STATUSES.filter(
  (status) => ISSUE_STATUS_CATEGORY[status] !== "completed" && ISSUE_STATUS_CATEGORY[status] !== "canceled",
);

export class InMemoryReleaseStore implements ReleaseStore {
  private readonly byId = new Map<string, ReleaseRecord>();
  private readonly events: OutboxEvent[] = [];
  private productPolicy?: (
    id: string,
  ) => { version?: number; policyDigest?: string; definitionDigest?: string } | undefined;

  // Bind the PRODUCT side of the cross-aggregate policy guard (mig 0150). The Pg twin evaluates it as an
  // EXISTS inside the write statement; unbound here, `expectProduct` ABSTAINS rather than refusing — an
  // in-memory pair that failed closed on an unwired link would break every unit path that never had one,
  // and the guard's whole purpose is the concurrent case a single-threaded fake cannot produce anyway.
  // The rest of the decision's read-set (arch-review 22 P0-1) — the in-memory twin of the Pg subqueries.
  // Unbound it ABSTAINS, exactly as `expectProduct` does: a single-threaded fake cannot produce the
  // interleaving anyway, and failing closed on an unwired link would break every unit path that has none.
  private decisionSources?: {
    openIssues(releaseId: string): number;
    newestCandidateAt(productId: string, seriesKey: string): string | undefined;
  };

  attachDecisionSources(sources: {
    openIssues(releaseId: string): number;
    newestCandidateAt(productId: string, seriesKey: string): string | undefined;
  }): void {
    this.decisionSources = sources;
  }

  attachProducts(products: {
    peek(
      id: string,
    ): { version?: number; releasePolicyDigest?: string; evaluationDefinitionDigest?: string } | undefined;
  }): void {
    this.productPolicy = (id) => {
      const p = products.peek(id);
      if (p === undefined) return undefined;
      return {
        version: p.version ?? 0,
        ...(p.releasePolicyDigest !== undefined ? { policyDigest: p.releasePolicyDigest } : {}),
        // BOTH digests (mig 0160). Omitting this one is not a smaller guard — it is no guard at all for the
        // half it covers, because the comparison reads an absent digest as "nothing to check".
        ...(p.evaluationDefinitionDigest !== undefined ? { definitionDigest: p.evaluationDefinitionDigest } : {}),
      };
    };
  }

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
    guard?: {
      expectStatus?: ReleaseStatus;
      expectVersion?: number;
      expectProduct?: { id: string; version: number; policyDigest: string; definitionDigest: string };
      expectDecision?: {
        openIssues: number;
        candidates: ReadonlyArray<{ productId: string; seriesKey: string; newestAt: string | null }>;
      };
    },
  ): Promise<ReleaseRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    // Terminal-race guard: the aggregate decided from the status it READ, so the write commits only from
    // that status. Otherwise two legal decisions (released / cancelled) both pass the domain and the last
    // writer wins — with the loser's fact already in the outbox.
    if (guard?.expectStatus !== undefined && current.status !== guard.expectStatus) return undefined;
    // The aggregate version catches a concurrent EDIT, which a status guard cannot see.
    if (guard?.expectVersion !== undefined && (current.version ?? 0) !== guard.expectVersion) return undefined;
    // …and the PRODUCT policy this decision stood on must still be the one it read — a different aggregate,
    // which no guard on this row could ever see move.
    if (guard?.expectProduct !== undefined && this.productPolicy !== undefined) {
      // Mirrors the Pg condition: the digest decides, the version stands in only for a legacy row.
      const live = this.productPolicy(guard.expectProduct.id);
      // Mirrors the Pg condition, PER DIMENSION (arch-review 16 P1-5): each digest guards its own question,
      // and a dimension with no digest yet falls back to the row VERSION rather than passing. Sharing one
      // fallback across both failed open whenever exactly one column was populated — which is what a rolling
      // deploy of mig 0160 produces on every product that already had a policy digest.
      const dimension = (live: string | undefined, expected: string, version: number): boolean =>
        live === undefined ? version === guard.expectProduct?.version : live === expected;
      const ok =
        live === undefined
          ? false
          : dimension(live.policyDigest, guard.expectProduct.policyDigest, live.version ?? 0) &&
            dimension(live.definitionDigest, guard.expectProduct.definitionDigest, live.version ?? 0);
      if (!ok) return undefined;
    }
    // …and the rest of the read-set: the issues this decision counted and the candidate it compared.
    if (guard?.expectDecision !== undefined && this.decisionSources !== undefined) {
      const sources = this.decisionSources;
      if (sources.openIssues(id) !== guard.expectDecision.openIssues) return undefined;
      for (const candidate of guard.expectDecision.candidates) {
        const newest = sources.newestCandidateAt(candidate.productId, candidate.seriesKey);
        // A candidate that appeared, or a NEWER one than the decision read, means the decision was made
        // about evidence that is no longer the latest — which is the selection predicate the recorded
        // scoring pin cannot express.
        if ((newest ?? null) !== candidate.newestAt) return undefined;
      }
    }
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

  // The in-memory half of the product's atomic cascade — see PgProductStore.removeAggregate. Synchronous so
  // the composition can perform the whole aggregate delete in one turn, which is this pair's equivalent of a
  // single statement.
  removeForProduct(tenant: string, productId: string): number {
    let removed = 0;
    for (const [id, r] of [...this.byId.entries()]) {
      if (r.tenant === tenant && r.productId === productId) {
        this.byId.delete(id);
        removed += 1;
      }
    }
    return removed;
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
  planned_series_keys: unknown;
  series_selection: string | null;
  components?: unknown;
}

const RELEASE_COLUMNS =
  "(id, tenant, product_id, name, description, status, target_date, released_at, series_keys, planned_series_keys, series_selection, history, created_by, created_at, updated_at, components)";
const RELEASE_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14::timestamptz,$15::timestamptz,$16::jsonb)";

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
    // The FROZEN scope (mig 0152). A column-mapping store drops what it does not name, and this is the field
    // the whole release-scope guarantee rests on — an unnamed one would have been silently absent forever.
    record.plannedSeriesKeys !== undefined ? JSON.stringify(record.plannedSeriesKeys) : null,
    record.seriesSelection ?? null,
    JSON.stringify(record.history),
    record.createdBy,
    record.createdAt,
    record.updatedAt,
    // The declared composition (mig 0162). NULL = never declared, which is a different fact from `[]` ("this
    // release ships no tracked service") — a column that collapsed the two would make the plan unreadable.
    record.components !== undefined ? JSON.stringify(record.components) : null,
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
    ...(row.planned_series_keys !== null && row.planned_series_keys !== undefined
      ? { plannedSeriesKeys: trackerIds(row.planned_series_keys) }
      : {}),
    ...(row.series_selection !== null && row.series_selection !== undefined
      ? { seriesSelection: row.series_selection }
      : {}),
    // NULL/absent = never declared (a row written before mig 0162, or a release nobody scoped). The schema
    // validates the elements; a non-array is dropped rather than handed to the domain half-formed.
    ...(Array.isArray(row.components) ? { components: row.components } : {}),
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
    guard?: {
      expectStatus?: ReleaseStatus;
      expectVersion?: number;
      expectProduct?: { id: string; version: number; policyDigest: string; definitionDigest: string };
      expectDecision?: {
        openIssues: number;
        candidates: ReadonlyArray<{ productId: string; seriesKey: string; newestAt: string | null }>;
      };
    },
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
    // …including the FROZEN scope (mig 0152): re-scoping a release re-freezes its promise, and a SET list
    // that omitted it would let an edit change `seriesKeys` while the release kept demanding the old gates.
    const sets = `name=$3, description=$4, status=$5, target_date=$6, released_at=$7::timestamptz,
       series_keys=$8::jsonb, planned_series_keys=$9::jsonb, series_selection=$10,
       history=$11::jsonb, updated_at=$12::timestamptz, version=$13, components=$14::jsonb`;
    const params: unknown[] = [
      tenant,
      id,
      next.name,
      next.description ?? null,
      next.status,
      next.targetDate ?? null,
      next.releasedAt ?? null,
      next.seriesKeys !== undefined ? JSON.stringify(next.seriesKeys) : null,
      next.plannedSeriesKeys !== undefined ? JSON.stringify(next.plannedSeriesKeys) : null,
      next.seriesSelection ?? null,
      JSON.stringify(next.history),
      next.updatedAt,
      next.version ?? 0,
      next.components !== undefined ? JSON.stringify(next.components) : null,
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
    // The CROSS-ROW half (arch-review 10 P0): the product's policy version, evaluated in the SAME statement
    // as the write. Read separately it would only be a wider window — the edit lands between the read and
    // the write and the decision commits anyway, which is exactly the race being closed.
    if (guard?.expectProduct !== undefined) {
      params.push(guard.expectProduct.policyDigest, guard.expectProduct.definitionDigest, guard.expectProduct.version);
      const digestIdx = params.length - 2;
      const defIdx = params.length - 1;
      const versionIdx = params.length;
      // CORRELATED to the row being updated, and TENANT-SCOPED (arch-review 13). The first version compared
      // `p.id = $callerSuppliedProductId` with no tenant clause — so the guard trusted the caller to restate
      // a relationship the database already holds (`everdict_product_releases.product_id`), and evaluated it
      // across every workspace. A trust boundary should never ask the application to re-assert what the
      // schema knows: correlating to the row makes the guard structurally about THIS release's product, and
      // the tenant clause makes it structurally about this workspace's.
      //
      // Self-healing (mig 0154/0160), PER DIMENSION (arch-review 16 P1-5). Each digest is the identity for
      // its own question and the row version is the fallback that dimension keeps until its column is
      // populated. The first version shared ONE fallback across both, which failed open on the exact
      // combination a rolling deploy produces: `release_policy_digest` populated by 0154, and
      // `evaluation_definition_digest` still NULL because no writer running the new code has touched the
      // product yet. The definition clause then passed on NULL, and the shared fallback was skipped BECAUSE
      // the policy digest was present — so an old replica could edit a series' definition, bump the version,
      // and a ship resolved against the pre-edit definition would still commit.
      //
      // Never `IS NULL → pass`: absence means "this dimension has no digest yet", and the honest stand-in is
      // the row version, which moves on every write including the edit we are guarding against. A legacy row
      // therefore conflicts slightly too eagerly — the safe direction, and self-healing on its next write.
      guardSql += ` AND EXISTS (SELECT 1 FROM everdict_products p WHERE p.tenant = everdict_product_releases.tenant AND p.id = everdict_product_releases.product_id AND (CASE WHEN p.release_policy_digest IS NULL THEN coalesce(p.version, 0)=$${versionIdx} ELSE p.release_policy_digest=$${digestIdx} END) AND (CASE WHEN p.evaluation_definition_digest IS NULL THEN coalesce(p.version, 0)=$${versionIdx} ELSE p.evaluation_definition_digest=$${defIdx} END))`;
    }
    // THE REST OF THE DECISION'S READ-SET, in the SAME statement (arch-review 22 P0-1). A ship decision is
    // computed from the open issues linked to this release and from the newest succeeded scorecard per
    // watched series; both live in this database, so both can be conditions on the write rather than reads
    // that went stale before it. Re-reading them first would only narrow the window — the same argument that
    // put the product policy in here.
    if (guard?.expectDecision !== undefined) {
      params.push(guard.expectDecision.openIssues);
      const openIdx = params.length;
      params.push(JSON.stringify([{ type: "release", id }]));
      const linkIdx = params.length;
      params.push(OPEN_ISSUE_STATUSES);
      const statusIdx = params.length;
      // The same predicate the readiness read used (`links @> [{type:"release", id}]`, non-terminal status),
      // evaluated at commit. A blocking issue linked between the decision and the write makes this false and
      // the release stays planned — instead of shipping a history entry that says `openIssues: 0`.
      guardSql += ` AND (SELECT count(*) FROM everdict_issues i WHERE i.tenant = everdict_product_releases.tenant AND i.links @> $${linkIdx}::jsonb AND i.status = ANY($${statusIdx}::text[])) = $${openIdx}`;
      for (const candidate of guard.expectDecision.candidates) {
        params.push(candidate.productId, candidate.seriesKey);
        const productIdx = params.length - 1;
        const keyIdx = params.length;
        if (candidate.newestAt === null) {
          // The decision saw NO evidence for this series. Any succeeded batch now is a different question.
          guardSql += ` AND NOT EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.tenant = everdict_product_releases.tenant AND s.origin->>'productId' = $${productIdx} AND s.origin->>'seriesKey' = $${keyIdx} AND s.status = 'succeeded')`;
        } else {
          params.push(candidate.newestAt);
          const atIdx = params.length;
          // A NEWER succeeded batch means the decision compared something that is no longer the latest —
          // the selection predicate ("S10 was latest"), which the recorded scoring pin cannot express.
          guardSql += ` AND NOT EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.tenant = everdict_product_releases.tenant AND s.origin->>'productId' = $${productIdx} AND s.origin->>'seriesKey' = $${keyIdx} AND s.status = 'succeeded' AND s.created_at > $${atIdx}::timestamptz)`;
        }
      }
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
