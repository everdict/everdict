import type { OutboxEvent, ScorecardListFilter, ScorecardStore } from "@everdict/application-control";
import { type ScorecardRecord, ScorecardRecordSchema } from "@everdict/contracts";
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
  sink_export: unknown;
  error: unknown;
  steps: unknown;
  run_ids: unknown;
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
    export: hasDetail ? (row.sink_export ?? undefined) : undefined, // for detail (get only, like steps). Column name is sink_export (reserved-word avoidance)
    error: row.error ?? undefined,
    steps: hasDetail ? (row.steps ?? undefined) : undefined,
    runIds: hasDetail ? (row.run_ids ?? undefined) : undefined, // detail-only lightweight reference (get only, like steps)
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

// Postgres-backed scorecard store. Same contract as in-memory — apps/api just swaps the two.
const SCORECARD_COLUMNS =
  "(id, tenant, kind, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, team_id, runtime, subset, orchestration, manifest, scorecard, analysis_ref, sink_export, error, steps, run_ids, created_at, updated_at)";
const SCORECARD_VALUES =
  "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)";

function scorecardInsertParams(r: ScorecardRecord): unknown[] {
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
    r.scorecard ? JSON.stringify(r.scorecard) : null,
    r.analysisRef ?? null,
    r.export ? JSON.stringify(r.export) : null,
    r.error ? JSON.stringify(r.error) : null,
    r.steps ? JSON.stringify(r.steps) : null,
    r.runIds ? JSON.stringify(r.runIds) : null,
    r.createdAt,
    r.updatedAt,
  ];
}

export class PgScorecardStore implements ScorecardStore {
  constructor(private readonly client: SqlClient) {}

  async create(r: ScorecardRecord, events?: OutboxEvent[]): Promise<void> {
    const base = scorecardInsertParams(r);
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
  ): Promise<ScorecardRecord | undefined> {
    // Only lifecycle fields are allowed to be updated (status/summary/scorecard/error/steps/updatedAt).
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
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
    if (events && events.length > 0) {
      // One statement, two writes (E0): the terminal patch and the facts describing it commit atomically —
      // and the facts land ONLY if the update matched a row (WHERE EXISTS on the updating CTE).
      const ev = eventValuesClause(events, vals.length + 1);
      const res = await this.client.query<ScorecardRow>(
        `WITH upd AS (UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${i} RETURNING *),
         ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
                SELECT * FROM (VALUES ${ev.sql}) AS v
                WHERE EXISTS (SELECT 1 FROM upd))
         SELECT * FROM upd`,
        [...vals, ...ev.params],
      );
      return res.rows[0] ? rowToRecord(res.rows[0], true) : undefined;
    }
    const res = await this.client.query<ScorecardRow>(
      `UPDATE everdict_scorecards SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
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
    const conds = ["($1::text IS NULL OR tenant = $1)"];
    const vals: unknown[] = [tenant ?? null];
    let i = 2;
    if (filter?.dataset) {
      conds.push(`dataset_id = $${i++}`);
      vals.push(filter.dataset);
    }
    if (filter?.harness) {
      conds.push(`harness_id = $${i++}`);
      vals.push(filter.harness);
    }
    if (filter?.status) {
      conds.push(`status = $${i++}`);
      vals.push(filter.status);
    }
    if (filter?.teamId) {
      conds.push(`team_id = $${i++}`);
      vals.push(filter.teamId);
    }
    if (filter?.visibleTeams) {
      // Ownership isolation — the caller may only see their own teams' batches. NULL (unowned: `_shared` seeds,
      // rows from before the team axis) is everyone's, so it is kept rather than swept up by a team the caller
      // does not happen to be on. An empty array is a real answer (on no team ⇒ only unowned), never "no filter".
      conds.push(`(team_id IS NULL OR team_id = ANY($${i++}::text[]))`);
      vals.push(filter.visibleTeams);
    }
    if (filter?.judge) {
      // jsonb containment on the persisted orchestration.judges — matches the judge id at any version.
      conds.push(`orchestration->'judges' @> $${i++}::jsonb`);
      vals.push(JSON.stringify([{ id: filter.judge }]));
    }
    if (filter?.scheduleId) {
      // jsonb field match on the persisted origin — the runs a schedule fired (source === "schedule").
      conds.push(`origin->>'scheduleId' = $${i++}`);
      vals.push(filter.scheduleId);
    }
    if (filter?.causedByRunId) {
      // the batches a run caused (§5.5 cascade-cancel walk) — jsonb field match on the persisted origin.
      conds.push(`origin->>'causedByRunId' = $${i++}`);
      vals.push(filter.causedByRunId);
    }
    if (filter?.kind) {
      // "scorecard" = every pre-mig-0093 row too (NULL) — experiments are the positively-marked minority.
      conds.push(filter.kind === "experiment" ? "kind = 'experiment'" : "(kind IS NULL OR kind <> 'experiment')");
    }
    const res = await this.client.query<ScorecardRow>(
      `SELECT id, tenant, kind, dataset_id, dataset_version, harness_id, harness_version, status, summary, models, judge_models, origin, created_by, team_id, runtime, subset, error, trace_projection_version, verdict_policy, created_at, updated_at
       FROM everdict_scorecards
       WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
      vals,
    );
    return res.rows.map((row) => rowToRecord(row, false));
  }
}
