import type {
  AttemptStamp,
  CleanupRelease,
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  RunCreateGuard,
  RunListOptions,
  RunStore,
  RunUpdateGuard,
} from "@everdict/application-control";
import { ConflictError } from "@everdict/contracts";
import {
  CANCELLED_ERROR_CODE,
  type RunRecord,
  RunRecordSchema,
  TERMINAL_RUN_STATUSES,
  TERMINAL_SCORECARD_STATUSES,
} from "@everdict/contracts";
import { PERSONAL_RUN_KINDS } from "@everdict/domain";
import { type SqlClient, withTransaction } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "./outbox.js";
import { PgExecutionAttemptStore } from "./pg-execution-attempt-store.js";
import { PgIntermediateCleanupStore } from "./pg-intermediate-cleanup-store.js";
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
  owner_epoch: string | number | null; // the driver's fencing token (mig 0170) — bigint arrives as a string
  webhook_url: string | null; // the run's completion callback, as durable intent (mig 0171)
  execution_id: string | null; // the correlation id it was dispatched with (mig 0172)
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
    ...(row.owner_epoch !== null && row.owner_epoch !== undefined ? { ownerEpoch: Number(row.owner_epoch) } : {}),
    ...(row.webhook_url ? { webhookUrl: row.webhook_url } : {}),
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  return withRunUsage(rec); // usage is not a column, it's derived from result.trace
}

const RUN_COLUMNS =
  "(id, tenant, harness_id, harness_version, case_id, status, result, error, parent_scorecard_id, trigger, created_by, team_id, runtime, case_spec, kind, class, lifetime, origin, envelope, placement, attach, group_ref, lineage, outputs, session, owner_replica, visibility, webhook_url, execution_id, created_at, updated_at)";
const RUN_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)";

// A conditional insert that matched nothing is a driver that has been replaced — the same answer the
// authority proof gives, so the caller aborts through the path it already has.
function refuseIfUncommitted(rows: number, guard: RunCreateGuard | undefined, runId: string): void {
  if (rows > 0 || !guard) return;
  throw new ConflictError(
    "CONFLICT",
    { scorecard: guard.parentDriver.scorecardId, run: runId },
    "this replica no longer drives the batch — the case was not committed to",
  );
}

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
    // The completion callback as durable intent (mig 0171) — see the record's own note for why it cannot
    // live in the request that started the run.
    r.webhookUrl ?? null,
    // The id its evidence is keyed by (mig 0172) — see the record's note on why it is not re-derived.
    r.executionId ?? null,
    r.createdAt,
    r.updatedAt,
  ];
}

// Postgres-backed result store. Same RunStore contract as in-memory — apps/api just swaps the two.
class UnsettledRunSignal extends Error {}

export class PgRunStore implements RunStore {
  // `replicaId` = the process this store belongs to; every row it inserts is stamped with it so boot recovery
  // can tell a dead driver's work from a live one's (docs/architecture/multi-replica.md).
  constructor(
    private readonly client: SqlClient,
    private readonly replicaId?: string,
  ) {}

  async create(r: RunRecord, events?: OutboxEvent[], guard?: RunCreateGuard): Promise<void> {
    const base = runInsertParams(r, this.replicaId);
    // The dispatch intent, committed under the parent's fencing token: `INSERT … SELECT … WHERE EXISTS` is the
    // same cross-row condition the child's later writes carry, asked at the moment the batch commits to
    // spending compute. A displaced driver inserts nothing, and a case with no child row is never dispatched.
    const parentSql = guard
      ? ` SELECT ${base.map((_, n) => `$${n + 1}`).join(", ")} WHERE EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = $${base.length + 1} AND s.owner_epoch = $${base.length + 2} AND s.status <> ALL($${base.length + 3}::text[]))`
      : undefined;
    // "IS IT STILL MINE" IS NOT "MAY I STILL SPEND" (arch-review 34 P1). A user's cancel settles the parent
    // terminal and does NOT raise its epoch — cancelling is not a takeover — so an epoch-only condition let a
    // loop that had already proved itself open a case for a batch the user had stopped. The dispatch intent
    // asks both halves, in one statement: this batch is mine, and it is still one that admits work.
    const parentParams = guard
      ? [guard.parentDriver.scorecardId, guard.parentDriver.epoch, [...TERMINAL_SCORECARD_STATUSES]]
      : [];
    if (events && events.length > 0) {
      // One statement, two writes (E0): the run insert and its facts commit or roll back together.
      const ev = eventValuesClause(events, base.length + parentParams.length + 1);
      const res = await this.client.query<{ id: string }>(
        `WITH ins AS (INSERT INTO everdict_runs ${RUN_COLUMNS} ${parentSql ?? `VALUES ${RUN_VALUES}`} RETURNING id),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins))
         SELECT id FROM ins`,
        [...base, ...parentParams, ...ev.params],
      );
      refuseIfUncommitted(res.rows.length, guard, r.id);
      return;
    }
    const res = await this.client.query<{ id: string }>(
      `INSERT INTO everdict_runs ${RUN_COLUMNS} ${parentSql ?? `VALUES ${RUN_VALUES}`} RETURNING id`,
      [...base, ...parentParams],
    );
    refuseIfUncommitted(res.rows.length, guard, r.id);
  }

  async update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    guard?: RunUpdateGuard,
  ): Promise<RunRecord | undefined> {
    return this.updateOn(this.client, id, patch, events, guard);
  }

  // ── THE STANDALONE LANE'S COMMIT POINT (arch-review 45) ────────────────────────────────────────────
  //
  // The fenced terminal write and the physical attempt's terminal stamp, all-or-nothing. As two round-trips
  // the window between them was the batch lane's old one wearing this lane's clothes: a crash there published
  // a SUCCEEDED run — completion fact, callback and all — whose attempt row still said `created`, a ledger
  // that never saw the execution it is supposed to be the record of end.
  //
  // The fence is NOT re-expressed here: the write goes through the same `updateOn` every settlement uses,
  // bound to the transaction, so the atomic path cannot drift from the ordinary one. A refused fence returns
  // undefined WITHOUT a rollback — nothing was written, and there is no claim to un-happen (the difference
  // from `commitCase`, whose claim lands before the settle and must be taken back). A stamp that throws
  // aborts the transaction, so the run stays open for recovery rather than settled behind an unwritable row.
  // Module-private control-flow signal: a refused fence must ROLL BACK the stamp written above it, and
  // `withTransaction` rolls back on a throw. Unwrapped below into the `undefined` the contract promises.
  async settleWith(
    id: string,
    patch: Partial<RunRecord>,
    events: OutboxEvent[] | undefined,
    guard: RunUpdateGuard,
    // The caller's ambient ledger is on `stamp.attempts` and deliberately unused: the stamp must go through
    // the SAME transaction as the write, so a transaction-bound twin is handed to it instead.
    stamp?: AttemptStamp,
    release?: CleanupRelease,
  ): Promise<RunRecord | undefined> {
    return withTransaction(this.client, "the run settlement (attempt stamp + terminal write)", async (tx) => {
      // ── THE STAMP GOES FIRST (arch-review 63 P1-high) ──────────────────────────────────────────────
      //
      // `committed` asks whether the parent may still be claimed, and `updateOn` below is the thing that
      // closes it. Inside one transaction the two writes commit together, but the GUARD still reads the row
      // as this transaction has left it — so settling first made the ledger refuse its own settlement, every
      // time. Being atomic is not the same as being ordered.
      if (stamp !== undefined) await stamp.apply(new PgExecutionAttemptStore(tx));
      const settled = await this.updateOn(tx, id, patch, events, guard);
      // …and a refused fence takes the stamp with it. Thrown rather than returned, because ROLLBACK is this
      // helper's contract for a throw — the same shape `commitCase` uses for its own refused child write.
      if (settled === undefined) throw new UnsettledRunSignal();
      // ── AND THE INTERMEDIATES BECOME COLLECTABLE IN THE SAME DECISION (arch-review 70 P1) ─────────
      //
      // After the fence held, so a refused settlement frees nothing — and inside the transaction, so a crash
      // between "this outcome is canonical" and "its artifacts may be swept" is not a state that exists. The
      // object deletes are the CALLER's, after the commit: a remote round trip has no business holding a
      // database transaction open, and the reconciler owns convergence either way.
      if (release !== undefined) await release.apply(new PgIntermediateCleanupStore(tx));
      return settled;
    }).catch((err: unknown) => {
      if (err instanceof UnsettledRunSignal) return undefined; // the fence refused; nothing was written
      throw err; // a store fault is reported as one — never converted into "somebody else settled it"
    });
  }

  private async updateOn(
    client: SqlClient,
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    guard?: RunUpdateGuard,
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
    // …and a CLAIM raises the fencing token in the same statement (mig 0170), so the replica this one
    // replaced discovers the takeover the only way a paused process reliably can: its next write fails.
    if (guard?.claimOwnership === true) sets.push("owner_epoch = owner_epoch + 1");
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.getOn(client, id);
    vals.push(id);
    // The scoring-pass FENCE (arch-review 8 P0) — a cross-row condition IN the write statement: this row
    // changes only while the named pass still owns the parent scorecard's marker. Evaluating it in the
    // service instead would leave exactly the window it exists to close (the winner settles and clears the
    // marker between the check and the write), so a superseded writer would still land on a settled plane.
    let fenceSql = "";
    // FIRST TERMINAL WRITE WINS, in the WHERE clause. The service still reads the row to BUILD the patch —
    // a settle is computed from the current record — but whether the row is still open to being settled is
    // decided by the database, at the instant of the write, because the competing writer is another process.
    if (guard?.expectNonTerminal === true) {
      vals.push([...TERMINAL_RUN_STATUSES]);
      fenceSql += ` AND status <> ALL($${vals.length}::text[])`;
    }
    // …and the payload half of the same rule: a cancelled settlement is never overwritten by a late result.
    if (guard?.expectNotCancelled === true) {
      vals.push(CANCELLED_ERROR_CODE);
      fenceSql += ` AND (error->>'code' IS DISTINCT FROM $${vals.length})`;
    }
    // A result that landed between a caller's read and this write refuses the write (arch-review 46) — the
    // fence form of `if (current?.result) continue`, which was a TOCTOU on the payload.
    if (guard?.expectNoResult === true) fenceSql += " AND result IS NULL";
    // The recovery claim: exactly one replica takes a dead one's run.
    if (guard?.expectOwnerReplica !== undefined) {
      if (guard.expectOwnerReplica === null) fenceSql += " AND owner_replica IS NULL";
      else {
        vals.push(guard.expectOwnerReplica);
        fenceSql += ` AND owner_replica = $${vals.length}`;
      }
    }
    // THE FENCE the driver proves on every write that drives this run (mig 0170).
    if (guard?.expectOwnerEpoch !== undefined) {
      vals.push(guard.expectOwnerEpoch);
      fenceSql += ` AND owner_epoch = $${vals.length}`;
    }
    // …and the PARENT batch's driver must still be the one asking (arch-review 33 P0). Same shape as the
    // scoring fence below: a cross-row condition inside the write, so "am I still this batch's driver" is
    // answered at the instant the child changes rather than a few lines earlier.
    if (guard?.parentDriver !== undefined) {
      const parentIdx = vals.length + 1;
      const epochIdx = vals.length + 2;
      fenceSql += ` AND EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = $${parentIdx} AND s.owner_epoch = $${epochIdx})`;
      vals.push(guard.parentDriver.scorecardId, guard.parentDriver.epoch);
    }
    const fence = guard?.scoring;
    if (fence) {
      const scorecardIdx = vals.length + 1;
      const passIdx = vals.length + 2;
      // …and the marker must still be LIVE, not merely still be this pass (arch-review 17 P0-3). A pass whose
      // workflow died terminally has its marker flipped to `failed` and its stage collected, and the comment
      // on that path says it "will never write again" — this is what enforces the sentence. Without it a late
      // activity of a dead pass still cleared every guard and wrote its judgment onto the child.
      fenceSql += ` AND EXISTS (SELECT 1 FROM everdict_scorecards s WHERE s.id = $${scorecardIdx} AND s.scoring_pass->>'passId' = $${passIdx} AND s.scoring_pass->>'status' = 'running')`;
      vals.push(fence.scorecardId, fence.passId);
    }
    // The cancel settle owns its teardown in the SAME statement (arch-review 52, Wave 3) — the run-scale
    // twin of `PgScorecardStore`'s. The operation row is inserted only when the settle matched a row
    // (WHERE EXISTS on the updating CTE), so a settle that lost the terminal race owes nothing. Requested-at
    // is the database's own clock; a re-request re-opens a completed row (idempotent-by-key, see the port).
    const cancelSql =
      guard?.requestCancellation === true
        ? `, cancel_op AS (INSERT INTO everdict_cancellation_operations (scorecard_id, target_kind, state)
                SELECT $${i}, 'run', 'requested'
                WHERE EXISTS (SELECT 1 FROM upd)
                ON CONFLICT (scorecard_id) DO UPDATE
                  SET state = 'requested', target_kind = 'run', last_error = NULL, completed_at = NULL, certificate = NULL)`
        : "";
    if (events && events.length > 0) {
      // One statement, two writes (E0): the terminal patch and the facts describing it commit atomically —
      // and the facts land ONLY if the update matched a row (WHERE EXISTS on the updating CTE).
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await client.query<RunRow>(
        `WITH upd AS (UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i}${fenceSql} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))${cancelSql}
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
    }
    if (cancelSql !== "") {
      const res = await client.query<RunRow>(
        `WITH upd AS (UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i}${fenceSql} RETURNING *)${cancelSql}
         SELECT * FROM upd`,
        vals,
      );
      return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
    }
    const res = await client.query<RunRow>(
      `UPDATE everdict_runs SET ${sets.join(", ")} WHERE id = $${i}${fenceSql} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    return this.getOn(this.client, id);
  }

  private async getOn(client: SqlClient, id: string): Promise<RunRecord | undefined> {
    const res = await client.query<RunRow>("SELECT * FROM everdict_runs WHERE id = $1", [id]);
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
