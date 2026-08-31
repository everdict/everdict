import type {
  OutboxEvent,
  ScorecardGroupBy,
  ScorecardGroupCount,
  ScorecardListFilter,
  ScorecardStore,
  ScorecardUpdateGuard,
} from "@everdict/application-control";
import { type ScorecardRecord, ScorecardRecordSchema, TERMINAL_SCORECARD_STATUSES } from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "./outbox.js";

interface ScorecardRow {
  id: string;
  tenant: string;
  kind: string | null; // group kind (mig 0093) — NULL = scorecard, 'experiment' = ungraded phase-1 group
  dataset_id: string;
  dataset_version: string;
  harness_id: string;
  harness_version: string;
  status: string;
  summary: unknown;
  orchestration: unknown; // resume/retry inputs (mig 0049)
  models: unknown;
  judge_models: unknown;
  origin: unknown;
  created_by: string | null;
  team_id: string | null; // owning team (mig 0106) — beside created_by, because ownership is metadata, not content
  runtime: string | null;
  subset: unknown;
  scorecard: unknown;
  analysis_ref: string | null;
  trace_projection_version: number | string | null;
  verdict_policy: unknown; // {id, version, digest} — which policy produced the verdicts (mig 0125)
  manifest: unknown; // reproducibility digests sealed at submit (mig 0126)
  requested: number | string | null; // the batch's ask — cases × trials at submit (mig 0127)
  gates: unknown; // release-gate decisions recorded against this candidate (mig 0128)
  decision: unknown;
  scoring: unknown; // append-only scoring-identity ledger — one entry per scoring pass (mig 0144)
  sink_export: unknown;
  publication: unknown; // the settlement's owed outward effects (mig 0187) — the publication outbox's plan
  error: unknown;
  steps: unknown;
  run_ids: unknown;
  owner_replica: string | null; // which control-plane replica drives this batch (mig 0135)
  owner_epoch?: string | number | null; // …and which takeover that is (mig 0166) — the driver's fencing token
  verdict_summary: unknown; // stamped-policy verdict aggregate (mig 0146) — what release-shaped surfaces read
  world: unknown; // the execution world cohort (mig 0161) — a comparison axis, NULL = no case reported one
  scoring_pass: unknown; // the LIVE scoring pass (mig 0147) — trust readers refuse while present
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

// row → ScorecardRecord. jsonb is already parsed by pg; timestamptz is Date → ISO. The contract is validated once with Zod.
// If hasDetail=false (list), the heavy scorecard/steps are omitted.
function rowToRecord(row: ScorecardRow, hasDetail: boolean): ScorecardRecord {
  return ScorecardRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    kind: row.kind ?? undefined, // lightweight → included in list too (experiment badge / analytics exclusion)
    dataset: { id: row.dataset_id, version: row.dataset_version },
    harness: { id: row.harness_id, version: row.harness_version },
    status: row.status,
    summary: row.summary ?? undefined,
    models: row.models ?? undefined, // lightweight → included in list too
    judgeModels: row.judge_models ?? undefined, // lightweight → included in list too (judge-axis filter/display)
    origin: row.origin ?? undefined, // lightweight → included in list too (trigger-provenance chip/commit link)
    createdBy: row.created_by ?? undefined, // lightweight → included in list too (runner display/filter)
    teamId: row.team_id ?? undefined, // lightweight → included in list too (the team axis is what the team page reads)
    runtime: row.runtime ?? undefined, // lightweight → included in list too (work-queue runtime axis)
    subset: row.subset ?? undefined, // lightweight → included in list too (partial-run badge)
    orchestration: row.orchestration ?? undefined, // resume/retry inputs (mig 0049) — lightweight
    scorecard: hasDetail ? (row.scorecard ?? undefined) : undefined,
    analysisRef: hasDetail ? (row.analysis_ref ?? undefined) : undefined, // detail-only download ref (get only, like steps)
    // Which projection the verdicts were read under (N6) — lightweight, so it rides the list too: a
    // comparison across batches judged under different projections is a comparison worth flagging.
    ...(row.trace_projection_version !== null && row.trace_projection_version !== undefined
      ? { traceProjectionVersion: Number(row.trace_projection_version) }
      : {}),
    // Which verdict policy the verdicts resolve under — lightweight, so it rides the list too: diff/
    // comparability flags a cross-policy comparison before anyone reads a delta.
    verdictPolicy: row.verdict_policy ?? undefined,
    manifest: hasDetail ? (row.manifest ?? undefined) : undefined, // provenance detail (get only)
    // lightweight — the list's denominators need the ask as much as the detail does
    ...(row.requested !== null && row.requested !== undefined ? { requested: Number(row.requested) } : {}),
    // lightweight — the gate audit scans the ledger for decisions; a handful of small artifacts per row
    ...(row.gates !== null && row.gates !== undefined ? { gates: row.gates as ScorecardRecord["gates"] } : {}),
    ...(row.decision !== null && row.decision !== undefined
      ? { decision: row.decision as ScorecardRecord["decision"] }
      : {}),
    // detail-shaped consumers (gate pins, diff, audit) read through get(); list omits the column like the other detail jsonb
    ...(row.scoring !== null && row.scoring !== undefined
      ? { scoring: row.scoring as ScorecardRecord["scoring"] }
      : {}),
    export: hasDetail ? (row.sink_export ?? undefined) : undefined, // for detail (get only, like steps). Column name is sink_export (reserved-word avoidance)
    // Lightweight, and it RIDES THE LIST deliberately (mig 0187): the publication reconciler finds owed
    // settlements by listing, and a column the list omits is a column the sweep cannot converge.
    ...(row.publication !== null && row.publication !== undefined
      ? { publication: row.publication as ScorecardRecord["publication"] }
      : {}),
    error: row.error ?? undefined,
    steps: hasDetail ? (row.steps ?? undefined) : undefined,
    runIds: hasDetail ? (row.run_ids ?? undefined) : undefined, // detail-only lightweight reference (get only, like steps)
    // Lightweight — boot recovery reads the LIST, so the owner must ride it or the check cannot be made.
    ownerReplica: row.owner_replica ?? undefined,
    ...(row.owner_epoch !== undefined && row.owner_epoch !== null ? { ownerEpoch: Number(row.owner_epoch) } : {}),
    // Lightweight — product readiness/timeline read the LIST, and this is the number they stand on.
    verdictSummary: (row.verdict_summary as ScorecardRecord["verdictSummary"]) ?? undefined,
    ...(row.world !== null && row.world !== undefined ? { world: row.world as ScorecardRecord["world"] } : {}),
    // Lightweight — trust readers deciding on list/get rows must SEE a live pass to refuse it.
    ...(row.scoring_pass !== null && row.scoring_pass !== undefined
      ? { scoringPass: row.scoring_pass as ScorecardRecord["scoringPass"] }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres-backed scorecard store. Same contract as in-memory — apps/api just swaps the two.
const SCORECARD_COLUMNS =
  "(id, tenant, kind, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, team_id, runtime, subset, orchestration, manifest, requested, scorecard, analysis_ref, sink_export, error, steps, run_ids, trace_projection_version, verdict_policy, gates, scoring, owner_replica, created_at, updated_at, verdict_summary, scoring_pass, world, publication)";
const SCORECARD_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)";

function scorecardInsertParams(r: ScorecardRecord, replicaId?: string): unknown[] {
  return [
    r.id,
    r.tenant,
    r.kind ?? null,
    r.dataset.id,
    r.dataset.version,
    r.harness.id,
    r.harness.version,
    r.status,
    r.summary ? JSON.stringify(r.summary) : null,
    r.models ? JSON.stringify(r.models) : null,
    r.judgeModels ? JSON.stringify(r.judgeModels) : null,
    r.origin ? JSON.stringify(r.origin) : null,
    r.createdBy ?? null,
    r.teamId ?? null,
    r.runtime ?? null,
    r.subset ? JSON.stringify(r.subset) : null,
    r.orchestration ? JSON.stringify(r.orchestration) : null,
    r.manifest ? JSON.stringify(r.manifest) : null,
    r.requested ?? null,
    r.scorecard ? JSON.stringify(r.scorecard) : null,
    r.analysisRef ?? null,
    r.export ? JSON.stringify(r.export) : null,
    r.error ? JSON.stringify(r.error) : null,
    r.steps ? JSON.stringify(r.steps) : null,
    r.runIds ? JSON.stringify(r.runIds) : null,
    // Update-era fields ride the INSERT too: a store that accepts a ScorecardRecord and silently drops
    // a field it knows the column for turns a caller's stamp into nothing (the owner_replica omission
    // in list() already bit boot recovery once — same trap, write side).
    r.traceProjectionVersion ?? null,
    r.verdictPolicy ? JSON.stringify(r.verdictPolicy) : null,
    r.gates ? JSON.stringify(r.gates) : null,
    r.scoring ? JSON.stringify(r.scoring) : null,
    // The writer is the driver — same stamp, same reason as the run store's.
    r.ownerReplica ?? replicaId ?? null,
    r.createdAt,
    r.updatedAt,
    r.verdictSummary ? JSON.stringify(r.verdictSummary) : null,
    r.scoringPass ? JSON.stringify(r.scoringPass) : null,
    r.world ? JSON.stringify(r.world) : null,
    // A newly created batch owes nothing outward yet; it rides the insert for the reason every other
    // update-era field does — a store that knows the column and drops the value turns a caller's stamp
    // into nothing.
    r.publication ? JSON.stringify(r.publication) : null,
  ];
}

export class PgScorecardStore implements ScorecardStore {
  // `replicaId` = the process this store belongs to; the batches it inserts are stamped with it so boot
  // recovery can tell a dead driver's batch from a live one's (docs/architecture/multi-replica.md).
  constructor(
    private readonly client: SqlClient,
    private readonly replicaId?: string,
  ) {}

  async create(r: ScorecardRecord, events?: OutboxEvent[]): Promise<void> {
    const base = scorecardInsertParams(r, this.replicaId);
    if (events && events.length > 0) {
      // One statement, two writes (E0): the scorecard insert and its facts commit or roll back together
      // (same data-modifying-CTE outbox as PgRunStore).
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_scorecards ${SCORECARD_COLUMNS} VALUES ${SCORECARD_VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_scorecards ${SCORECARD_COLUMNS} VALUES ${SCORECARD_VALUES}`, base);
  }

  async update(
    id: string,
    patch: Partial<ScorecardRecord>,
    events?: OutboxEvent[],
    guard?: ScorecardUpdateGuard,
  ): Promise<ScorecardRecord | undefined> {
    // Only lifecycle fields are allowed to be updated (status/summary/scorecard/error/steps/updatedAt).
    const sets: string[] = [];
    // The epoch RISES in the same statement as the claim (mig 0166): being told which takeover you are and
    // winning it cannot be two writes — that gap is the race the token exists to close.
    if (guard?.claimOwnership === true) sets.push("owner_epoch = owner_epoch + 1");
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    // Ownership TRANSFER — the replica that claims an interrupted batch for resume becomes its driver.
    if (patch.ownerReplica !== undefined) {
      sets.push(`owner_replica = $${i++}`);
      vals.push(patch.ownerReplica);
    }
    if (patch.kind !== undefined) {
      // written by P2 scoring only — promoting an experiment flips kind to the explicit 'scorecard'.
      sets.push(`kind = $${i++}`);
      vals.push(patch.kind);
    }
    if (patch.summary !== undefined) {
      sets.push(`summary = $${i++}`);
      vals.push(JSON.stringify(patch.summary));
    }
    if (patch.orchestration !== undefined) {
      // submit stamps workflowId onto the persisted orchestration (batch-on-Temporal) — silently dropping this
      // left records unmarked and boot recovery double-driving workflow-owned batches.
      sets.push(`orchestration = $${i++}`);
      vals.push(JSON.stringify(patch.orchestration));
    }
    if (patch.manifest !== undefined) {
      // a re-score refreshes manifest.judges/judgeRun to the merged effective set (scoring identity follows
      // the judgment) — dropping it would keep certifying the submit-era judges over a re-judged plane.
      sets.push(`manifest = $${i++}`);
      vals.push(JSON.stringify(patch.manifest));
    }
    if (patch.models !== undefined) {
      sets.push(`models = $${i++}`);
      vals.push(JSON.stringify(patch.models));
    }
    if (patch.judgeModels !== undefined) {
      sets.push(`judge_models = $${i++}`);
      vals.push(JSON.stringify(patch.judgeModels));
    }
    if (patch.origin !== undefined) {
      sets.push(`origin = $${i++}`);
      vals.push(JSON.stringify(patch.origin));
    }
    if (patch.scorecard !== undefined) {
      sets.push(`scorecard = $${i++}`);
      vals.push(JSON.stringify(patch.scorecard));
    }
    if (patch.analysisRef !== undefined) {
      // set at finalize (succeed) — dropping it left the record with no download ref even when the object store held it.
      sets.push(`analysis_ref = $${i++}`);
      vals.push(patch.analysisRef);
    }
    if (patch.traceProjectionVersion !== undefined) {
      sets.push(`trace_projection_version = $${i++}`);
      vals.push(patch.traceProjectionVersion);
    }
    if (patch.requested !== undefined) {
      // the pull-ingest path learns its ask only after listing the platform's traces — patched then.
      sets.push(`requested = $${i++}`);
      vals.push(patch.requested);
    }
    if (patch.decision !== undefined) {
      sets.push(`decision = $${i++}`);
      vals.push(JSON.stringify(patch.decision));
    }
    if (patch.publication !== undefined) {
      // settle (the plan) and drain (the receipt) — mig 0187. A lane that dropped this would commit a
      // settlement whose outward effects nobody is owed, which is the pre-Wave-4 behavior with extra steps.
      sets.push(`publication = $${i++}`);
      vals.push(JSON.stringify(patch.publication));
    }
    if (patch.gates !== undefined) {
      // append-path (gate decide/override) — the service writes the whole array back (small artifacts).
      sets.push(`gates = $${i++}`);
      vals.push(JSON.stringify(patch.gates));
    }
    if (patch.scoring !== undefined) {
      // append-path (settle/rescore) — the scoring-identity ledger; the service writes the whole array back.
      sets.push(`scoring = $${i++}`);
      vals.push(JSON.stringify(patch.scoring));
    }
    if (patch.world !== undefined) {
      // settle — the execution world cohort (mig 0161). The column was missing when the axis shipped, so
      // every derived cohort was dropped here: green in memory, absent in production. A patch lane that
      // silently omits a field the record carries is the write-side twin of a list() that omits a column.
      sets.push(`world = $${i++}`);
      vals.push(JSON.stringify(patch.world));
    }
    if (patch.verdictSummary !== undefined) {
      // settle/rescore — the stamped-policy verdict aggregate (mig 0146); dropping it would leave release
      // surfaces standing on the pre-rescore number.
      sets.push(`verdict_summary = $${i++}`);
      vals.push(JSON.stringify(patch.verdictSummary));
    }
    if (patch.scoringPass !== undefined) {
      // pass start (object) / settle-or-takeover clear (null) — the revision-boundary marker; a lane that
      // dropped it would let trust readers consume a plane between revisions.
      //
      // With `stampScoringLeaseSeconds`, the lease's END is written by the DATABASE rather than carried in
      // the payload: the same clock that later judges the lease expired is the one that set it (see the port).
      // jsonb_set over the caller's object, so every other field of the marker is exactly what it sent.
      if (guard?.stampScoringLeaseSeconds !== undefined && patch.scoringPass !== null) {
        const passIdx = i++;
        const secIdx = i++;
        sets.push(
          // AT TIME ZONE 'UTC' before formatting — `now()` renders in the SESSION's zone, and stamping a
          // literal "Z" onto a local rendering would write an instant hours away from the one meant. The
          // reclaimability guard parses this back as timestamptz, so the two must agree on the zone.
          `scoring_pass = jsonb_set($${passIdx}::jsonb, '{leaseUntil}', to_jsonb(to_char((now() + ($${secIdx} || ' seconds')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`,
        );
        vals.push(JSON.stringify(patch.scoringPass), String(guard.stampScoringLeaseSeconds));
      } else {
        sets.push(`scoring_pass = $${i++}`);
        vals.push(patch.scoringPass ? JSON.stringify(patch.scoringPass) : null);
      }
    }
    if (patch.verdictPolicy !== undefined) {
      // stamped by the domain's terminal transition (judgedUnder) — dropping it would leave historical
      // verdicts undated and silently re-derived under whatever policy the code ships next.
      sets.push(`verdict_policy = $${i++}`);
      vals.push(JSON.stringify(patch.verdictPolicy));
    }
    if (patch.export !== undefined) {
      sets.push(`sink_export = $${i++}`);
      vals.push(JSON.stringify(patch.export));
    }
    if (patch.error !== undefined) {
      sets.push(`error = $${i++}`);
      vals.push(JSON.stringify(patch.error));
    }
    if (patch.steps !== undefined) {
      sets.push(`steps = $${i++}`);
      vals.push(JSON.stringify(patch.steps));
    }
    if (patch.runIds !== undefined) {
      sets.push(`run_ids = $${i++}`);
      vals.push(JSON.stringify(patch.runIds));
    }
    if (patch.updatedAt !== undefined) {
      sets.push(`updated_at = $${i++}`);
      vals.push(patch.updatedAt);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    const idIdx = i; // the id's 1-based parameter position — guard params follow it
    // The append-only ledgers' optimistic guard (I5): the whole-array rewrite commits only if the persisted
    // length still matches what the caller read — two racers both writing [1,2x] can no longer eat an entry.
    // A guard miss matches zero rows and answers undefined, exactly like a missing id; the caller (which
    // just read the record) treats it as the concurrent-writer conflict it is.
    let guardSql = "";
    if (guard?.expectScoringCount !== undefined) {
      i++;
      guardSql += ` AND coalesce(jsonb_array_length(scoring), 0) = $${i}`;
      vals.push(guard.expectScoringCount);
    }
    // The decision context's freshness CAS (review 40): receipts are insert-only, so the COUNT the settle
    // read is a sound fence — a receipt committed between the read and this write refuses the settle, and
    // the recorded read-set can never describe a ledger the summary was not computed over.
    if (guard?.expectReceiptCount !== undefined) {
      i++;
      guardSql += ` AND (SELECT count(*) FROM everdict_case_commit_receipts r WHERE r.scorecard_id = everdict_scorecards.id) = $${i}`;
      vals.push(guard.expectReceiptCount);
    }
    if (guard?.expectGatesCount !== undefined) {
      i++;
      guardSql += ` AND coalesce(jsonb_array_length(gates), 0) = $${i}`;
      vals.push(guard.expectGatesCount);
    }
    // The pass-claim CAS (arch-review 8 P0): exactly one claimant may stamp an epoch onto this row. `null`
    // asks for "no epoch persisted" — an absent marker OR a legacy one — so the first claimant to write an
    // epoch makes every rival's condition false. This is what turns the marker into a lock.
    // The FENCE. A UUID is never reused, so "the marker is still this pass" cannot be satisfied by a later
    // pass that happens to hold the same counter value — which is exactly what an epoch-only guard allowed
    // once a settle cleared the marker and the numbering restarted.
    // FIRST TERMINAL WRITE WINS for the aggregate (arch-review 29 P0) — in SQL, at the instant of the write,
    // because the writer that settled this batch is in another process by construction.
    if (guard?.expectNonTerminal === true) {
      i++;
      guardSql += ` AND status <> ALL($${i}::text[])`;
      vals.push([...TERMINAL_SCORECARD_STATUSES]);
    }
    if (guard?.expectStatusIn !== undefined) {
      i++;
      guardSql += ` AND status = ANY($${i}::text[])`;
      vals.push([...guard.expectStatusIn]);
    }
    // THE EXPORT PROJECTION MOVES FORWARD ONLY (arch-review 56, Wave F). Conditioned in the write rather
    // than read-then-written: two publishers at once is this seam's ordinary shape, so a position read
    // followed by an unconditional update let an older settlement land on a newer one's receipt. A stored
    // receipt with no revision is older than every revision — a pre-Wave-F receipt is exactly that, not an
    // unknown — which `COALESCE(..., 0)` states.
    if (guard?.expectExportRevisionBelow !== undefined) {
      i++;
      // `sink_export`, not `export`: the RECORD field is `export` and the COLUMN is not (mig 0048 says so in
      // its own comment). Naming the field here made this the one statement the guard exists to protect
      // fail outright — `column "export" does not exist` — so the reader-facing projection never advanced
      // while the historical protocol underneath it was perfectly correct (arch-review 58).
      guardSql += ` AND COALESCE((sink_export->>'scoringRevision')::int, 0) < $${i}`;
      vals.push(guard.expectExportRevisionBelow);
    }
    // THE FENCE the driver proves on every write that drives this batch (mig 0166).
    if (guard?.expectOwnerEpoch !== undefined) {
      i++;
      guardSql += ` AND owner_epoch = $${i}`;
      vals.push(guard.expectOwnerEpoch);
    }
    // THE RECOVERY CLAIM — exactly one replica may take a dead one's work (arch-review 28 P1).
    if (guard?.expectOwnerReplica !== undefined) {
      if (guard.expectOwnerReplica === null) guardSql += " AND owner_replica IS NULL";
      else {
        i++;
        guardSql += ` AND owner_replica = $${i}`;
        vals.push(guard.expectOwnerReplica);
      }
    }
    // THE PUBLICATION'S FENCE (mig 0187): the drain writes its receipt only while the plan it read is still
    // the pending one, so two publishers produce exactly one receipt.
    if (guard?.expectPublicationState !== undefined) {
      i++;
      guardSql += ` AND publication->>'state' = $${i}`;
      vals.push(guard.expectPublicationState);
    }
    if (guard?.expectScoringPassId !== undefined) {
      if (guard.expectScoringPassId === null) {
        guardSql += " AND (scoring_pass IS NULL OR scoring_pass->>'passId' IS NULL)";
      } else {
        i++;
        guardSql += ` AND scoring_pass->>'passId' = $${i}`;
        vals.push(guard.expectScoringPassId);
        // …AND STILL LIVE (arch-review 17 P0-3). The fence answered "who is this?" and never "does it still
        // have the right?" — so a pass whose workflow died terminally, whose marker `failScore` had flipped
        // to `failed` and whose stage had been collected, could still land a late activity's write, and a
        // late finalize could still append a revision and clear the marker. A terminal state has to be a
        // CAPABILITY REVOCATION, or "declared dead" is a comment rather than a rule.
        //
        // `status` is required on every marker the schema can produce, so this is strict rather than
        // absence-tolerant — the fail-closed direction, and the only one that makes the sentence true.
        //
        // The exception is a caller that says it is TAKING OVER a dead marker: `expectScoringPassReclaimable`
        // is exactly that declaration, and a takeover of a failed pass is the main reason the flag exists.
        if (guard.expectScoringPassReclaimable !== true) guardSql += " AND scoring_pass->>'status' = 'running'";
      }
    }
    // The DATABASE's clock decides reclaimability — the one clock every replica shares. `now()` is the
    // transaction timestamp, so the read and the decision cannot drift apart the way an application clock
    // and a later write can.
    if (guard?.expectScoringPassReclaimable === true) {
      guardSql +=
        " AND (scoring_pass IS NULL OR scoring_pass->>'status' = 'failed'" +
        " OR (scoring_pass ? 'leaseUntil' AND (scoring_pass->>'leaseUntil')::timestamptz <= now())" +
        " OR (NOT (scoring_pass ? 'leaseUntil') AND (scoring_pass->>'startedAt')::timestamptz <= now() - interval '1 hour'))";
    }
    if (guard?.expectScoringPassEpoch !== undefined) {
      if (guard.expectScoringPassEpoch === null) {
        guardSql += " AND (scoring_pass IS NULL OR scoring_pass->>'epoch' IS NULL)";
      } else {
        i++;
        guardSql += ` AND (scoring_pass->>'epoch')::bigint = $${i}`;
        vals.push(guard.expectScoringPassEpoch);
      }
    }
    // The abort settle owns its teardown in the SAME statement (arch-review 51 P0): the cancellation
    // operation upsert rides the update exactly like the outbox events — applied only when the settle
    // matched a row (WHERE EXISTS on the updating CTE), so a refused settle owes nothing. Requested-at is
    // the database's own clock; a re-request re-opens a completed row (idempotent-by-key, see the port).
    const cancelSql =
      guard?.requestCancellation === true
        ? `, cancel_op AS (INSERT INTO everdict_cancellation_operations (scorecard_id, state)
                SELECT $${idIdx}, 'requested'
                WHERE EXISTS (SELECT 1 FROM upd)
                ON CONFLICT (scorecard_id) DO UPDATE
                  SET state = 'requested', last_error = NULL, completed_at = NULL)`
        : "";
    // …and the settlement's owed PUBLICATION, by the same rule (arch-review 53, Wave C): inserted only when
    // the settle matched a row, and idempotent on the operation id so two replicas settling one pass owe one
    // debt. Insert-only — a re-score adds its own row rather than overwriting the previous settlement's.
    const publishSql =
      guard?.publishOperation !== undefined
        ? (() => {
            const op = guard.publishOperation;
            const base = vals.length;
            vals.push(
              op.id,
              op.settlement.scorecardId,
              op.settlement.scoringRevision,
              op.settlement.passId,
              JSON.stringify(op.effects),
              op.plannedAt,
            );
            return `, pub_op AS (INSERT INTO everdict_publication_operations
                  (id, scorecard_id, scoring_revision, pass_id, state, effects, planned_at)
                SELECT $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'pending', $${base + 5}::jsonb, $${base + 6}::timestamptz
                WHERE EXISTS (SELECT 1 FROM upd)
                ON CONFLICT (id) DO NOTHING)`;
          })()
        : "";
    if (events && events.length > 0) {
      // One statement, two writes (E0): the terminal patch and the facts describing it commit atomically —
      // and the facts land ONLY if the update matched a row (WHERE EXISTS on the updating CTE).
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await this.client.query<ScorecardRow>(
        `WITH upd AS (UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${idIdx}${guardSql} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))${cancelSql}${publishSql}
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
    }
    if (cancelSql !== "" || publishSql !== "") {
      const res = await this.client.query<ScorecardRow>(
        `WITH upd AS (UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${idIdx}${guardSql} RETURNING *)${cancelSql}${publishSql}
         SELECT * FROM upd`,
        vals,
      );
      return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
    }
    const res = await this.client.query<ScorecardRow>(
      `UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${idIdx}${guardSql} RETURNING *`,
      vals,
    );
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async get(id: string): Promise<ScorecardRecord | undefined> {
    const res = await this.client.query<ScorecardRow>("SELECT * FROM everdict_scorecards WHERE id = $1", [id]);
    return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.client.query<{ id: string }>("DELETE FROM everdict_scorecards WHERE id = $1 RETURNING id", [
      id,
    ]);
    return res.rows.length > 0;
  }

  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    // Don't SELECT the heavy scorecard column (lighter list). Filters narrow via the SQL WHERE (leaderboard/trend).
    const { conds, vals, put } = scorecardFilterSql(tenant, filter);
    // Keyset, not OFFSET: the row-value comparison matches the ORDER BY below exactly, so a page is "strictly
    // older than the last row I showed" — stable while new batches land at the head, which is where they land.
    if (filter?.before !== undefined) {
      conds.push(`(created_at, id) < (${put(filter.before.createdAt)}::timestamptz, ${put(filter.before.id)})`);
    }
    const limit = filter?.limit === undefined ? "" : ` LIMIT ${put(Math.max(0, filter.limit))}`;
    const res = await this.client.query<ScorecardRow>(
      // owner_replica rides the LIST projection because boot recovery reads batches through list() and
      // decides on `ownerReplica` alone: omitted, every record reads unowned and a booting replica tombstones
      // batches a live replica is still driving. It is one text column, not a heavy one.
      // …and `publication` rides it for the same kind of reason (mig 0187): the publication reconciler finds
      // owed settlements through list(), so a column omitted here is a settlement nobody converges.
      `SELECT id, tenant, kind, dataset_id, dataset_version, harness_id, harness_version, status, summary, verdict_summary, world, scoring_pass, scoring, models, judge_models, origin, created_by, team_id, runtime, subset, error, trace_projection_version, verdict_policy, requested, gates, publication, owner_replica, owner_epoch, created_at, updated_at
       FROM everdict_scorecards
       WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id DESC${limit}`,
      vals,
    );
    return res.rows.map((row) => rowToRecord(row, false));
  }

  async countByGroup(
    tenant: string | undefined,
    groupBy: ScorecardGroupBy,
    filter?: ScorecardListFilter,
  ): Promise<ScorecardGroupCount[]> {
    // The page fields are deliberately NOT applied: a count is about the set, and one narrowed by the cursor
    // would hand the caller back the page size it already knows.
    const { conds, vals } = scorecardFilterSql(tenant, filter);
    // The key expression comes from a fixed table keyed by a closed union — never interpolated from input.
    const res = await this.client.query<{ key: string | null; count: string | number }>(
      `SELECT ${GROUP_KEY_SQL[groupBy]} AS key, COUNT(*) AS count
       FROM everdict_scorecards
       WHERE ${conds.join(" AND ")}
       GROUP BY 1`,
      vals,
    );
    return res.rows.map((row) => ({ key: row.key ?? null, count: Number(row.count) }));
  }
}

// The bucket expression per axis. A closed union indexes it, so nothing a caller sends reaches the SQL text.
// `day` is the UTC calendar day of the stored instant — the same key the in-memory twin and the web derive,
// so a group header cannot disagree with the rows under it.
const GROUP_KEY_SQL: Record<ScorecardGroupBy, string> = {
  day: "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
  status: "status",
  harness: "harness_id",
  dataset: "dataset_id",
  team: "team_id",
  creator: "created_by",
};

// The ONE predicate `list` and `countByGroup` share. Written twice, the next facet would have been added to
// one of them and the page would have disagreed with its own header (protocol L3). `put` appends a parameter
// and answers its placeholder, so a caller can keep adding its own (the cursor, the limit) after the filter.
function scorecardFilterSql(
  tenant: string | undefined,
  filter: ScorecardListFilter | undefined,
): { conds: string[]; vals: unknown[]; put: (value: unknown) => string } {
  const conds = ["($1::text IS NULL OR tenant = $1)"];
  const vals: unknown[] = [tenant ?? null];
  const put = (value: unknown): string => {
    vals.push(value);
    return `$${vals.length}`;
  };
  if (filter?.dataset) conds.push(`dataset_id = ${put(filter.dataset)}`);
  if (filter?.harness) conds.push(`harness_id = ${put(filter.harness)}`);
  if (filter?.status) conds.push(`status = ${put(filter.status)}`);
  if (filter?.teamId) conds.push(`team_id = ${put(filter.teamId)}`);
  if (filter?.visibleTeams) {
    // Ownership isolation — the caller may only see their own teams' batches. NULL (unowned: `_shared` seeds,
    // rows from before the team axis) is everyone's, so it is kept rather than swept up by a team the caller
    // does not happen to be on. An empty array is a real answer (on no team ⇒ only unowned), never "no filter".
    conds.push(`(team_id IS NULL OR team_id = ANY(${put(filter.visibleTeams)}::text[]))`);
  }
  // jsonb containment on the persisted orchestration.judges — matches the judge id at any version.
  if (filter?.judge) conds.push(`orchestration->'judges' @> ${put(JSON.stringify([{ id: filter.judge }]))}::jsonb`);
  // jsonb field match on the persisted origin — the runs a schedule fired (source === "schedule").
  if (filter?.scheduleId) conds.push(`origin->>'scheduleId' = ${put(filter.scheduleId)}`);
  // the product timeline's trend read (expression-indexed, mig 0138) — the batches a product's version
  // imports fanned out, optionally narrowed to one watch series.
  if (filter?.productId) conds.push(`origin->>'productId' = ${put(filter.productId)}`);
  if (filter?.seriesKey) conds.push(`origin->>'seriesKey' = ${put(filter.seriesKey)}`);
  // the batches a run caused (§5.5 cascade-cancel walk) — jsonb field match on the persisted origin.
  if (filter?.causedByRunId) conds.push(`origin->>'causedByRunId' = ${put(filter.causedByRunId)}`);
  if (filter?.publicationPending === true) {
    // the publication reconciler's sweep (mig 0187) — matches the partial index exactly, so it reads the
    // owed settlements rather than the whole table.
    conds.push("publication->>'state' = 'pending'");
  }
  if (filter?.kind) {
    // "scorecard" = every pre-mig-0093 row too (NULL) — experiments are the positively-marked minority.
    conds.push(filter.kind === "experiment" ? "kind = 'experiment'" : "(kind IS NULL OR kind <> 'experiment')");
  }
  if (filter?.runtime) conds.push(`runtime = ${put(filter.runtime)}`);
  if (filter?.createdBy) conds.push(`created_by = ${put(filter.createdBy)}`);
  // The facet SETS — `= ANY($n::text[])`, with `coalesce(col, '')` where the axis has an unset bucket, so
  // "no runtime" is a value the filter can name rather than a row it can never reach.
  if (filter?.statuses) conds.push(`status = ANY(${put(filter.statuses)}::text[])`);
  if (filter?.datasets) conds.push(`dataset_id = ANY(${put(filter.datasets)}::text[])`);
  if (filter?.harnesses) conds.push(`harness_id = ANY(${put(filter.harnesses)}::text[])`);
  if (filter?.runtimes) conds.push(`coalesce(runtime, '') = ANY(${put(filter.runtimes)}::text[])`);
  if (filter?.creators) conds.push(`coalesce(created_by, '') = ANY(${put(filter.creators)}::text[])`);
  if (filter?.teamIds) conds.push(`coalesce(team_id, '') = ANY(${put(filter.teamIds)}::text[])`);
  if (filter?.day) {
    // A half-open UTC range rather than a cast on the column: this one can use
    // `everdict_scorecards_tenant_created_idx`, and `(created_at)::date` cannot.
    const from = put(`${filter.day}T00:00:00Z`);
    conds.push(`created_at >= ${from}::timestamptz AND created_at < ${from}::timestamptz + interval '1 day'`);
  }
  if (filter?.search) {
    // `strpos` over lowercased text rather than ILIKE: the needle is user input and would otherwise need its
    // LIKE metacharacters escaped — a `%` typed in the search box must find a percent sign, not everything.
    const needle = put(filter.search.toLowerCase());
    conds.push(
      `(strpos(lower(id), ${needle}) > 0 OR strpos(lower(harness_id), ${needle}) > 0 OR strpos(lower(dataset_id), ${needle}) > 0)`,
    );
  }
  return { conds, vals, put };
}
