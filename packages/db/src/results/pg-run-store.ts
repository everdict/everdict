import type {
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  RunListOptions,
  RunScoringFence,
  RunStore,
} from "@everdict/application-control";
import { type RunRecord, RunRecordSchema } from "@everdict/contracts";
import { PERSONAL_RUN_KINDS } from "@everdict/domain";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "./outbox.js";
import { withRunUsage } from "./run-store.js";

interface RunRow {
  id: string;
  tenant: string;
  harness_id: string;
  harness_version: string;
  case_id: string;
  status: string;
  result: unknown;
  error: unknown;
  parent_scorecard_id: string | null;
  trigger: string | null;
  created_by: string | null;
  team_id: string | null; // owning team (mig 0106) — beside created_by, because ownership is metadata, not content
  runtime: string | null;
  case_spec: unknown | null;
  // The universal-run shape (mig 0092) — nullable; absent = legacy eval run.
  kind: string | null;
  class: string | null;
  lifetime: string | null;
  origin: unknown | null;
  envelope: unknown | null;
  placement: unknown | null;
  attach: unknown | null;
  group_ref: unknown | null;
  lineage: unknown | null;
  outputs: unknown | null;
  session: unknown | null;
  owner_replica: string | null; // which control-plane replica drives this run (mig 0135)
  visibility: string | null; // creation-time audience fact (mig 0143) — NULL = legacy class/kind inference
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → RunRecord (jsonb is already parsed by pg; timestamptz is Date → ISO). The contract is validated once with Zod.
function rowToRecord(row: RunRow): RunRecord {
  const rec = RunRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    harness: { id: row.harness_id, version: row.harness_version },
    caseId: row.case_id,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    parentScorecardId: row.parent_scorecard_id ?? undefined,
    trigger: row.trigger ?? undefined,
    createdBy: row.created_by ?? undefined,
    teamId: row.team_id ?? undefined,
    runtime: row.runtime ?? undefined,
    ...(row.case_spec ? { caseSpec: row.case_spec } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.class ? { class: row.class } : {}),
    ...(row.lifetime ? { lifetime: row.lifetime } : {}),
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.envelope ? { envelope: row.envelope } : {}),
    ...(row.placement ? { placement: row.placement } : {}),
    ...(row.attach ? { attach: row.attach } : {}),
    ...(row.group_ref ? { group: row.group_ref } : {}),
    ...(row.lineage ? { lineage: row.lineage } : {}),
    ...(row.outputs ? { outputs: row.outputs } : {}),
    ...(row.session ? { session: row.session } : {}),
    ...(row.owner_replica ? { ownerReplica: row.owner_replica } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return withRunUsage(rec); // usage is not a column, it's derived from result.trace
}

const RUN_COLUMNS =
  "(id, tenant, harness_id, harness_version, case_id, status, result, error, parent_scorecard_id, trigger, created_by, team_id, runtime, case_spec, kind, class, lifetime, origin, envelope, placement, attach, group_ref, lineage, outputs, session, owner_replica, visibility, created_at, updated_at)";
const RUN_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)";

function runInsertParams(r: RunRecord, replicaId?: string): unknown[] {
  return [
    r.id,
    r.tenant,
    r.harness.id,
    r.harness.version,
    r.caseId,
    r.status,
    r.result ? JSON.stringify(r.result) : null,
    r.error ? JSON.stringify(r.error) : null,
    r.parentScorecardId ?? null,
    r.trigger ?? null,
    r.createdBy ?? null,
    r.teamId ?? null,
    r.runtime ?? null,
    r.caseSpec ? JSON.stringify(r.caseSpec) : null,
    r.kind ?? null,
    r.class ?? null,
    r.lifetime ?? null,
    r.origin ? JSON.stringify(r.origin) : null,
    r.envelope ? JSON.stringify(r.envelope) : null,
    r.placement ? JSON.stringify(r.placement) : null,
    r.attach ? JSON.stringify(r.attach) : null,
    r.group ? JSON.stringify(r.group) : null,
    r.lineage ? JSON.stringify(r.lineage) : null,
    r.outputs ? JSON.stringify(r.outputs) : null,
    r.session ? JSON.stringify(r.session) : null,
    // The writer is the driver: whoever inserts the row is the process about to drive it, so ownership is
    // stamped HERE rather than threaded through every submit path (and cannot be forged by a caller).
    r.ownerReplica ?? replicaId ?? null,
    r.visibility ?? null,
    r.createdAt,
    r.updatedAt,
  ];
}

// Postgres-backed result store. Same RunStore contract as in-memory — apps/api just swaps the two.
export class PgRunStore implements RunStore {
  // `replicaId` = the process this store belongs to; every row it inserts is stamped with it so boot recovery
  // can tell a dead driver's work from a live one's (docs/architecture/multi-replica.md).
  constructor(
    private readonly client: SqlClient,
    private readonly replicaId?: string,
  ) {}

  async create(r: RunRecord, events?: OutboxEvent[]): Promise<void> {
    const base = runInsertParams(r, this.replicaId);
    if (events && events.length > 0) {
      // One statement, two writes (E0): the run insert and its facts commit or roll back together.
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_runs ${RUN_COLUMNS} VALUES ${RUN_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_runs ${RUN_COLUMNS} VALUES ${RUN_VALUES}`, base);
  }

  async update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    fence?: RunScoringFence,
  ): Promise<RunRecord | undefined> {
    // Only lifecycle fields are allowed to be updated (status/result/error/runtime/updatedAt).
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    if (patch.result !== undefined) {
      sets.push(`result = $${i++}`);
      vals.push(JSON.stringify(patch.result));
    }
    if (patch.error !== undefined) {
      sets.push(`error = $${i++}`);
      vals.push(JSON.stringify(patch.error));
    }
    // Spillover provenance — settle rewrites the assigned runtime to the one that actually ran the case.
    if (patch.runtime !== undefined) {
      sets.push(`runtime = $${i++}`);
      vals.push(patch.runtime);
    }
    if (patch.outputs !== undefined) {
      sets.push(`outputs = $${i++}`);
      vals.push(JSON.stringify(patch.outputs));
    }
    if (patch.lineage !== undefined) {
      sets.push(`lineage = $${i++}`);
      vals.push(JSON.stringify(patch.lineage));
    }
    // Session close stamps closedReason on the session half (P6) — a dropped key here would settle the
    // row while silently losing WHY it closed.
    if (patch.session !== undefined) {
      sets.push(`session = $${i++}`);
      vals.push(JSON.stringify(patch.session));
    }
    // Ownership TRANSFER — the replica that claims an orphaned run for resume becomes its driver, or the next
    // boot would still see the dead owner and reclaim work that is now being driven again.
    if (patch.ownerReplica !== undefined) {
      sets.push(`owner_replica = $${i++}`);
      vals.push(patch.ownerReplica);
    }
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    // The scoring-pass FENCE (arch-review 8 P0) — a cross-row condition IN the write statement: this row
    // changes only while the named pass still owns the parent scorecard's marker. Evaluating it in the
    // service instead would leave exactly the window it exists to close (the winner settles and clears the
    // marker between the check and the write), so a superseded writer would still land on a settled plane.
    let fenceSql = "";
    if (fence) {
      const scorecardIdx = i + 1;
      const passIdx = i + 2;
      // …and the marker must still be LIVE, not merely still be this pass (arch-review 17 P0-3). A pass whose
      // workflow died terminally has its marker flipped to `failed` and its stage collected, and the comment
      // on that path says it "will never write again" — this is what enforces the sentence. Without it a late
      // activity of a dead pass still cleared every guard and wrote its judgment onto the child.
      fenceSql = ` AND EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = $${scorecardIdx} AND s.scoring_pass->>'passId' = $${passIdx} AND s.scoring_pass->>'status' = 'running')`;
      vals.push(fence.scorecardId, fence.passId);
    }
    if (events && events.length > 0) {
      // One statement, two writes (E0): the terminal patch and the facts describing it commit atomically —
      // and the facts land ONLY if the update matched a row (WHERE EXISTS on the updating CTE).
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await this.client.query<RunRow>(
        `WITH upd AS (UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i}${fenceSql} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
    }
    const res = await this.client.query<RunRow>(
      `UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i}${fenceSql} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const res = await this.client.query<RunRow>("SELECT * FROM everdict_runs WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]> {
    // scorecardId given → that batch's children only; else includeChildren ($3) → all runs (standalone + children);
    // otherwise standalone (parentless) runs only (children hidden → prevents activity-list flooding).
    // runnerId ($4) → runs this self-hosted runner executed (jsonb result.provenance.runner); implies children
    // included. limit ($5, NULL = all) caps the activity feed. LIMIT NULL is valid Postgres (unlimited). offset ($6,
    // default 0) skips the first N rows for the runner-detail activity feed's offset pagination.
    // viewer ($7, NULL = an internal read) applies the run-audience rule IN the query: a personal kind
    // (PERSONAL_RUN_KINDS — agent turns, sandbox shells) is readable only by the member it belongs to, which is
    // `origin.actor` falling back to `created_by`, and an ownerless one stays the workspace's. This restates
    // `runAudience` (@everdict/domain, the SSOT) because the filter must run BEFORE LIMIT — filtering the page
    // afterwards would let one member's chat history push everyone else's runs off the reader's screen. The
    // store tests assert this clause and the in-memory `canReadRun` path agree. visibleTeams ($9, NULL = nothing
    // is hidden) is the second, orthogonal ceiling: a PRIVATE team's runs are that team's work, and an unowned
    // run is the workspace's. Both narrow before LIMIT for the same reason.
    const res = await this.client.query<RunRow>(
      `SELECT * FROM everdict_runs
       WHERE ($1::text IS NULL OR tenant = $1)
         AND ($4::text IS NULL OR result->'provenance'->>'runner' = $4)
         AND (
           ($2::text IS NOT NULL AND parent_scorecard_id = $2)
           OR ($2::text IS NULL AND ($3::bool OR $4::text IS NOT NULL OR parent_scorecard_id IS NULL))
         )
         AND (
           $7::text IS NULL
           OR NOT (kind = ANY($8::text[]))
           OR visibility = 'workspace'
           OR (visibility IS NULL AND kind = 'agent' AND class = 'background')
           OR COALESCE(origin->>'actor', created_by) IS NULL
           OR COALESCE(origin->>'actor', created_by) = $7
         )
         AND ($9::text[] IS NULL OR team_id IS NULL OR team_id = ANY($9::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT $5 OFFSET $6`,
      [
        tenant ?? null,
        opts?.scorecardId ?? null,
        opts?.includeChildren ?? false,
        opts?.runnerId ?? null,
        opts?.limit ?? null,
        opts?.offset ?? 0,
        opts?.viewer ?? null,
        [...PERSONAL_RUN_KINDS],
        opts?.visibleTeams ?? null,
      ],
    );
    return res.rows.map(rowToRecord);
  }

  async deleteByScorecard(scorecardId: string): Promise<number> {
    const res = await this.client.query<{ id: string }>(
      "DELETE FROM everdict_runs WHERE parent_scorecard_id = $1 RETURNING id",
      [scorecardId],
    );
    return res.rows.length;
  }

  async countActiveByEnvelope(tenant: string, envelopeId: string): Promise<number> {
    const res = await this.client.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM everdict_runs
       WHERE tenant = $1 AND envelope->>'id' = $2 AND status IN ('queued', 'running')`,
      [tenant, envelopeId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  // The scheduler's admission count as the LEDGER knows it — every replica's in-flight eval work, not just this
  // process's (AdmissionLedger). `running` only: a queued row is still waiting in some replica's scheduler queue,
  // and counting those against the quota that decides whether it may start would deadlock a tenant at quota.
  // Legacy rows carry no `kind`, which means eval; sessions are bounded by the session pool's own cap instead.
  async inFlightByTenant(): Promise<Record<string, number>> {
    const res = await this.client.query<{ tenant: string; n: string | number }>(
      `SELECT tenant, count(*) AS n FROM everdict_runs
       WHERE status = 'running' AND (kind IS NULL OR kind = 'eval') AND (lifetime IS NULL OR lifetime <> 'session')
       GROUP BY tenant`,
    );
    const counts: Record<string, number> = {};
    for (const row of res.rows) counts[row.tenant] = Number(row.n);
    return counts;
  }

  // ── HARD quota admission (AdmissionLedger.tryAdmit — TRUST-07, mig 0139) ──
  // The claim is ONE UPDATE on the tenant's counter row: under READ COMMITTED a concurrent claim waits on
  // the row lock and then RE-EVALUATES `in_flight < quota` on the LATEST row version (the update re-check),
  // which is the one single-statement shape that closes the same-instant double-admit window. (A count-then-
  // insert — with or without an advisory lock — keeps its statement-start snapshot after unblocking, so two
  // replicas counting the same headroom both insert; that race is exactly what this replaces.)
  // A permit is a LEASE (mig 0140): the scheduler renews the permits of work it is still running, and the
  // reap frees only permits whose lease lapsed. What that buys, PRECISELY: race-proof admission plus crash
  // recovery — a replica that dies stops renewing and its leak heals in at most this window (throttling its
  // tenant briefly), while a healthy long run keeps renewing instead of being reaped on wall-clock age. What
  // it does NOT buy is partition fencing: a replica cut off from the DATABASE but not from its orchestrator
  // keeps driving compute while its renewals fail — "stopped renewing" and "stopped running" are
  // indistinguishable here — so after the window another replica may admit replacement work and the fleet
  // briefly exceeds the quota by the partitioned holder's share. Closing that needs fencing (renewal-failure
  // self-kill, or fenced execution tokens the backends verify): the named next step if hard-under-partition
  // is ever required.
  private static readonly ADMISSION_LEASE = "30 minutes";

  async tryAdmit(tenant: string, permitId: string, quota: number): Promise<boolean> {
    // Ensure the counter row exists (idempotent), then self-heal any lapsed-lease permits. Separate atomic
    // statements: healing needs no serialization with the claim — a racing heal at worst frees slots a beat
    // late, and the claim itself stays the single race-proof statement. The sweep is GLOBAL on purpose: a
    // tenant that stopped submitting never asks again, so its leaked permits must heal on ANY admission,
    // not only its own next one.
    await this.client.query(
      `INSERT INTO everdict_tenant_admission_counters (tenant, in_flight) VALUES ($1, 0)
       ON CONFLICT (tenant) DO NOTHING`,
      [tenant],
    );
    await this.client.query(
      `WITH reaped AS (
         DELETE FROM everdict_tenant_admissions
          WHERE renewed_at < now() - interval '${PgRunStore.ADMISSION_LEASE}'
          RETURNING tenant
       ), losses AS (
         SELECT tenant, count(*) AS n FROM reaped GROUP BY tenant
       )
       UPDATE everdict_tenant_admission_counters c
          SET in_flight = greatest(0, c.in_flight - losses.n), updated_at = now()
         FROM losses
        WHERE c.tenant = losses.tenant`,
    );
    // CONSERVATION: in_flight must always equal the tenant's live permit rows. The permit id is the unit of
    // quota, so a RETRY of a claim whose commit outran its response (the scheduler reuses the entry's permit id)
    // is the SAME right, not a second one: the `existing` arm answers "already held" as success, and the counter
    // arm is guarded on NOT EXISTS so it can never increment twice for one permit. Without that guard the
    // conflict-absorbed INSERT left a PERMANENT phantom (+1 the release path decremented only once and the reap
    // — with no row left to reap — never recovered). Same-permit calls are sequential by construction (one
    // scheduler entry retries after its previous attempt settled), so the statement-snapshot read of `existing`
    // is never stale; concurrent DIFFERENT permits still serialize on the counter row's EvalPlanQual re-check.
    const res = await this.client.query<{ held: string | number; admitted: string | number }>(
      `WITH existing AS (
         SELECT 1 FROM everdict_tenant_admissions WHERE permit_id = $2
       ), claimed AS (
         UPDATE everdict_tenant_admission_counters
            SET in_flight = in_flight + 1, updated_at = now()
          WHERE tenant = $1 AND in_flight < $3
            AND NOT EXISTS (SELECT 1 FROM existing)
          RETURNING tenant
       ), permit AS (
         INSERT INTO everdict_tenant_admissions (permit_id, tenant)
         SELECT $2, $1 FROM claimed
         ON CONFLICT (permit_id) DO NOTHING
       )
       SELECT (SELECT count(*) FROM existing) AS held, (SELECT count(*) FROM claimed) AS admitted`,
      [tenant, permitId, quota],
    );
    const row = res.rows[0];
    return Number(row?.held ?? 0) > 0 || Number(row?.admitted ?? 0) > 0;
  }

  // The lease heartbeat: the scheduler renews every permit of work it is still running. Renewing an already
  // released (or reaped) permit updates no row — harmless by construction.
  async renewAdmissions(permitIds: string[]): Promise<void> {
    if (permitIds.length === 0) return;
    await this.client.query("UPDATE everdict_tenant_admissions SET renewed_at = now() WHERE permit_id = ANY($1)", [
      permitIds,
    ]);
  }

  // Idempotent by construction: a double release deletes no permit row, so it decrements nothing.
  async releaseAdmission(permitId: string): Promise<void> {
    await this.client.query(
      `WITH removed AS (
         DELETE FROM everdict_tenant_admissions WHERE permit_id = $1 RETURNING tenant
       )
       UPDATE everdict_tenant_admission_counters c
          SET in_flight = greatest(0, c.in_flight - 1), updated_at = now()
         FROM removed
        WHERE c.tenant = removed.tenant`,
      [permitId],
    );
  }

  // The session pool as the LEDGER knows it — every replica's held-open compute, not just this process's.
  // No time predicate here on purpose (see the port): the deadline is judged by the clock that wrote it.
  async liveSessions(query: LiveSessionQuery = {}): Promise<LiveSessionRow[]> {
    const params: unknown[] = [];
    const where = ["lifetime = 'session'", "status IN ('queued', 'running')"];
    if (query.tenant !== undefined) {
      params.push(query.tenant);
      where.push(`tenant = $${params.length}`);
    }
    if (query.trigger !== undefined) {
      params.push(query.trigger);
      where.push(`trigger = $${params.length}`);
    }
    const res = await this.client.query<{
      id: string;
      tenant: string;
      created_by: string | null;
      agent_id: string | null;
      expires_at: string | null;
    }>(
      `SELECT id, tenant, created_by, session->'agent'->>'agentId' AS agent_id, session->>'expiresAt' AS expires_at
       FROM everdict_runs WHERE ${where.join(" AND ")}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      ...(r.created_by !== null ? { createdBy: r.created_by } : {}),
      ...(r.agent_id !== null ? { agentId: r.agent_id } : {}),
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    }));
  }
}
