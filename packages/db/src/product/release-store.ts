import type {
  CapabilityGenerationStore,
  OutboxEvent,
  ReleaseListFilter,
  ReleaseStore,
} from "@everdict/application-control";
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
        candidates: ReadonlyArray<{
          productId: string;
          seriesKey: string;
          pin: {
            scorecardId: string;
            createdAt: string;
            scoringRevision?: number | undefined;
            scorePlaneDigest?: string | undefined;
          } | null;
        }>;
        capabilities?: ReadonlyArray<{
          kind: "dataset" | "harness" | "judge" | "rubric" | "model";
          id: string;
          generation: number | null;
        }>;
        settingsRevision?: number | null;
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
      // Both digests, no version fallback (arch-review 23, legacy sweep) — a product that cannot state its
      // policy and definition identity cannot have a ship decided against it.
      const ok =
        live !== undefined &&
        live.policyDigest === guard.expectProduct.policyDigest &&
        live.definitionDigest === guard.expectProduct.definitionDigest;
      if (!ok) return undefined;
    }
    // …and the rest of the read-set: the issues this decision counted and the candidate it compared.
    if (guard?.expectDecision !== undefined && this.decisionSources !== undefined) {
      const sources = this.decisionSources;
      if (sources.openIssues(id) !== guard.expectDecision.openIssues) return undefined;
      // The capability half has no in-memory twin: the fence is a subquery over registry TABLES, and an
      // in-process registry has no insert timestamp to compare. It abstains, exactly as `expectProduct` does
      // when unbound — the concurrent registration it covers cannot happen in a single-threaded fake.
      for (const candidate of guard.expectDecision.candidates) {
        const newest = sources.newestCandidateAt(candidate.productId, candidate.seriesKey);
        // A candidate that appeared, or a NEWER one than the decision read, means the decision was made
        // about evidence that is no longer the latest — the selection predicate a scoring pin cannot express.
        // The in-memory twin compares the recency half only; the judgment half is a jsonb read the Pg guard
        // does in SQL and a fake has no equivalent of.
        if ((newest ?? null) !== (candidate.pin?.createdAt ?? null)) return undefined;
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
        candidates: ReadonlyArray<{
          productId: string;
          seriesKey: string;
          pin: {
            scorecardId: string;
            createdAt: string;
            scoringRevision?: number | undefined;
            scorePlaneDigest?: string | undefined;
          } | null;
        }>;
        capabilities?: ReadonlyArray<{
          kind: "dataset" | "harness" | "judge" | "rubric" | "model";
          id: string;
          generation: number | null;
        }>;
        settingsRevision?: number | null;
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
      params.push(guard.expectProduct.policyDigest, guard.expectProduct.definitionDigest);
      const digestIdx = params.length - 1;
      const defIdx = params.length;
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
      // BOTH DIGESTS, no version fallback (arch-review 23, legacy sweep). The fallback existed for products
      // written before the columns did: a NULL digest fell back to the row VERSION, which moves on every
      // write and therefore conflicted a little too eagerly — the safe direction, and a reason to keep it
      // while such rows existed. They no longer need to. A product that cannot state its policy and
      // definition identity cannot have a ship decided against it, and saying so beats a guard whose
      // strength depends on which columns a row happens to have.
      guardSql += ` AND EXISTS (SELECT 1 FROM everdict_products p WHERE p.tenant = everdict_product_releases.tenant AND p.id = everdict_product_releases.product_id AND p.release_policy_digest=$${digestIdx} AND p.evaluation_definition_digest=$${defIdx})`;
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
        const series = `s.tenant = everdict_product_releases.tenant AND s.origin->>'productId' = $${productIdx} AND s.origin->>'seriesKey' = $${keyIdx} AND s.status = 'succeeded'`;
        if (candidate.pin === null) {
          // The decision saw NO evidence for this series. Any succeeded batch now is a different question.
          guardSql += ` AND NOT EXISTS (SELECT 1 FROM everdict_scorecards s WHERE ${series})`;
          continue;
        }
        params.push(candidate.pin.scorecardId, candidate.pin.createdAt);
        const idIdx = params.length - 1;
        const atIdx = params.length;
        // ① THE PINNED ROW IS STILL THERE, still succeeded, and NOT under a live scoring pass. A deleted
        //    candidate leaves nothing "newer" to find, and a pass that claimed the plane after the gate read
        //    it means the evidence is mid-revision at the moment of commit.
        guardSql += ` AND EXISTS (SELECT 1 FROM everdict_scorecards s WHERE ${series} AND s.id = $${idIdx} AND s.scoring_pass IS NULL)`;
        // ② …AND IT IS STILL THE JUDGMENT THE GATE READ. A re-score of the SAME row leaves `created_at`
        //    untouched while replacing the verdict — the case a timestamp fence is structurally blind to.
        //    Compared against the ledger's last entry, which is what `currentScoringPin` reads.
        if (candidate.pin.scoringRevision !== undefined && candidate.pin.scorePlaneDigest !== undefined) {
          params.push(candidate.pin.scoringRevision, candidate.pin.scorePlaneDigest);
          const revIdx = params.length - 1;
          const digestIdx = params.length;
          guardSql += ` AND EXISTS (SELECT 1 FROM everdict_scorecards s WHERE ${series} AND s.id = $${idIdx} AND (s.scoring -> -1 ->> 'revision')::int = $${revIdx} AND s.scoring -> -1 ->> 'scorePlaneDigest' = $${digestIdx})`;
        }
        // ③ …AND NOTHING NEWER HAS LANDED. Ordered by (created_at, id) exactly as the read that chose it —
        //    a row arriving in the same millisecond is not `>` a timestamp, and the tie-break is what the
        //    list ordering already uses to decide which of the two is latest.
        guardSql += ` AND NOT EXISTS (SELECT 1 FROM everdict_scorecards s WHERE ${series} AND (s.created_at, s.id) > ($${atIdx}::timestamptz, $${idIdx}))`;
      }
      // …AND THE CAPABILITY REGISTRIES, as far as a row can speak for them. A new version, or a
      // workspace-local document shadowing a `_shared` one, changes what a series' refs resolve to — and both
      // arrive as INSERTS in tables this database owns, so they are conditions the write can hold rather than
      // drift only a later read would notice. `_shared` is included because that is where the fallback comes
      // from: a first-party dataset gaining a version moves `latest` for every workspace that inherits it.
      //
      // A soft DELETE moves no `created_at`, and workspace settings are a different row entirely; both stay
      // covered by the service's contract re-verify, whose window is decision→commit rather than zero.
      // Naming which half is which beats one guard that implies it covers both.
      for (const ref of guard.expectDecision.capabilities ?? []) {
        params.push(ref.kind, ref.id);
        const kindIdx = params.length - 1;
        const idIdx = params.length;
        const row = `g.kind = $${kindIdx} AND g.id = $${idIdx} AND g.tenant IN (everdict_product_releases.tenant, '_shared')`;
        if (ref.generation === null) {
          // No generation row when the decision read it — the name has never been mutated under this fence.
          // One appearing since is a mutation, whatever it did.
          guardSql += ` AND NOT EXISTS (SELECT 1 FROM everdict_capability_generation g WHERE ${row})`;
          continue;
        }
        params.push(ref.generation);
        const genIdx = params.length;
        // The generation moves on every write that can change what this NAME resolves to — a registration, a
        // revive, a soft delete. Comparing it (rather than a timestamp) is what makes the fence cover the two
        // mutations that leave `created_at` untouched.
        guardSql += ` AND EXISTS (SELECT 1 FROM everdict_capability_generation g WHERE ${row} AND g.generation = $${genIdx})`;
      }
      // …and the workspace SETTINGS the contracts resolved under (mig 0164) — the default judge model is part
      // of the contract identity, and it lives on a row this statement can condition on.
      const settingsRevision = guard.expectDecision.settingsRevision;
      if (settingsRevision === null) {
        guardSql +=
          " AND NOT EXISTS (SELECT 1 FROM everdict_workspace_settings w WHERE w.workspace = everdict_product_releases.tenant)";
      } else if (settingsRevision !== undefined) {
        params.push(settingsRevision);
        const revIdx = params.length;
        guardSql += ` AND EXISTS (SELECT 1 FROM everdict_workspace_settings w WHERE w.workspace = everdict_product_releases.tenant AND w.revision = $${revIdx})`;
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

// THE CAPABILITY RESOLUTION GENERATIONS (mig 0163) — what a decision reads before resolving its contracts and
// holds as a condition on its commit.
//
// Both the tenant's own row and `_shared`'s are read, because owner-first resolution means either can change
// what a name answers: a workspace registering its own `support@1` shadows the shared document, and the
// shared one gaining a version moves `latest` for everyone who inherits it. The MAXIMUM of the two is the
// name's generation — a single number that moves whichever side mutated.
export class PgCapabilityGenerationStore implements CapabilityGenerationStore {
  constructor(private readonly client: SqlClient) {}

  async read(
    tenant: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
  ): Promise<Array<{ kind: string; id: string; generation: number | null }>> {
    if (refs.length === 0) return [];
    const { rows } = await this.client.query<{ kind: string; id: string; generation: string | number }>(
      `SELECT kind, id, max(generation) AS generation FROM everdict_capability_generation
       WHERE tenant IN ($1, '_shared') AND (kind, id) IN (${refs
         .map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`)
         .join(", ")})
       GROUP BY kind, id`,
      [tenant, ...refs.flatMap((ref) => [ref.kind, ref.id])],
    );
    const found = new Map(rows.map((row) => [`${row.kind}:${row.id}`, Number(row.generation)]));
    // A name with no row is `null`, not zero: "never mutated" and "mutated to generation 0" would be the same
    // number, and the fence has to be able to refuse when the first mutation appears.
    return refs.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      generation: found.get(`${ref.kind}:${ref.id}`) ?? null,
    }));
  }

  async settingsRevision(workspace: string): Promise<number | null> {
    const { rows } = await this.client.query<{ revision: string | number }>(
      "SELECT revision FROM everdict_workspace_settings WHERE workspace = $1",
      [workspace],
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.revision);
  }
}
