import type {
  CampaignAppendOutcome,
  CampaignCloseOutcome,
  CampaignSubjectRef,
  EvolutionCampaignStore,
  OutboxEvent,
  ReserveCampaignEvaluation,
} from "@everdict/application-control";
import {
  type AdoptionOperation,
  type CampaignClose,
  type CampaignEvaluation,
  CampaignEvaluationSchema,
  type CampaignEvidenceGrant,
  CampaignEvidenceGrantSchema,
  type CampaignRound,
  type CampaignState,
  ConflictError,
  type EvolutionCampaignRecord,
  EvolutionCampaignRecordSchema,
  type ExperimentFamily,
  ExperimentFamilySchema,
} from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { type SqlClient, withTransaction } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";
import { familyMembers, reserveInFamily } from "./experiment-family.js";

// ── EvolutionCampaignStore impls (docs/architecture/evolution-lineage.md, Track D) ───────────────────
//
// Both twins make the SAME decisions — the append CAS on the round count and the open-only close guard —
// so a unit test over the in-memory store exercises the refusal a production Postgres would give (rule
// `testing`: a guard the in-memory twin does not have is a guard no unit test can see). Facts ride the
// same write via the E0 outbox `events` parameter, exactly as the tracker stores carry theirs.

// Reserve every open campaign's remaining allocation before its evaluations can start.
// Closed campaigns retain their spent rounds. The database serializes this decision with create.
function assertFamilyCapacity(
  record: EvolutionCampaignRecord,
  records: EvolutionCampaignRecord[],
  attempts: CampaignEvaluation[] = [],
): void {
  if (!record.frame.continues) return;
  const byId = new Map(records.map((r) => [r.id, r]));
  let root = record.frame.continues;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(root)) throw new ConflictError("CONFLICT", {}, "cyclic experiment family");
    visited.add(root);
    const parent = byId.get(root);
    if (!parent) throw new ConflictError("CONFLICT", {}, "experiment family predecessor is missing");
    if (!parent.frame.continues) break;
    root = parent.frame.continues;
  }
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of records)
      if (r.frame.continues && family.has(r.frame.continues) && !family.has(r.id)) {
        family.add(r.id);
        grew = true;
      }
  }
  const limit = byId.get(root)?.frame.significance.heldOutFamilySize;
  const reserved = records
    .filter((r) => family.has(r.id))
    .reduce(
      (n, r) =>
        n +
        (r.state === "open"
          ? r.frame.budget.maxRounds
          : r.rounds.filter((round) => !round.verdict.evaluationId).length +
            attempts.filter((a) => a.campaignId === r.id).length),
      0,
    );
  if (
    limit === undefined ||
    record.frame.significance.heldOutFamilySize !== limit ||
    reserved + record.frame.budget.maxRounds > limit
  )
    throw new ConflictError(
      "CONFLICT",
      { reserved, limit },
      "experiment family has insufficient unreserved held-out budget",
    );
}

export class InMemoryEvolutionCampaignStore implements EvolutionCampaignStore {
  private readonly byId = new Map<string, EvolutionCampaignRecord>();
  private readonly grants = new Map<string, CampaignEvidenceGrant>();
  async createEvidenceGrant(grant: CampaignEvidenceGrant) {
    if (this.grants.has(grant.tokenHash)) throw new ConflictError("CONFLICT", {}, "evidence grant already exists");
    this.grants.set(grant.tokenHash, structuredClone(grant));
    return structuredClone(grant);
  }
  async evidenceGrant(tokenHash: string) {
    return structuredClone(this.grants.get(tokenHash));
  }
  private readonly families = new Map<string, ExperimentFamily>();
  private readonly evaluations = new Map<string, CampaignEvaluation>();

  async reserveEvaluation(input: ReserveCampaignEvaluation) {
    const records = [...this.byId.values()].filter((r) => r.tenant === input.tenant);
    const { root } = familyMembers(input.campaignId, records);
    const result = reserveInFamily(
      input,
      records,
      this.families.get(`${input.tenant}/${root.id}`),
      [...this.evaluations.values()].filter((a) => a.tenant === input.tenant),
    );
    this.families.set(`${input.tenant}/${root.id}`, result.family);
    this.evaluations.set(result.evaluation.id, result.evaluation);
    return { kind: result.kind, evaluation: structuredClone(result.evaluation), scorecardId: result.scorecardId };
  }

  async evaluationForScorecard(tenant: string, scorecardId: string) {
    return structuredClone(
      [...this.evaluations.values()].find(
        (a) =>
          a.tenant === tenant && (a.baseline?.scorecardId === scorecardId || a.candidate?.scorecardId === scorecardId),
      ),
    );
  }

  async family(tenant: string, campaignId: string) {
    const { root } = familyMembers(
      campaignId,
      [...this.byId.values()].filter((r) => r.tenant === tenant),
    );
    return structuredClone(this.families.get(`${tenant}/${root.id}`));
  }

  // The authorizations this store's closes have written. One process holds both; the Pg deployment splits
  // them because the CONSUMER is the registry write, not the campaign.
  private readonly adoptions = new Map<string, AdoptionOperation>();
  private readonly events: OutboxEvent[] = [];

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    if (this.byId.has(record.id)) throw new Error(`campaign ${record.id} already exists`);
    assertFamilyCapacity(
      record,
      [...this.byId.values()].filter((r) => r.tenant === record.tenant),
      [...this.evaluations.values()].filter((a) => a.tenant === record.tenant),
    );
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's row reads as nonexistent
  }

  // ── THE LIST IS TEAM-FILTERED (arch-review 76 P1-security) ──────────────────────────────────────
  //
  async list(tenant: string, subject?: CampaignSubjectRef): Promise<EvolutionCampaignRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant)
      .filter(
        (r) => subject === undefined || (r.frame.subject.type === subject.type && r.frame.subject.id === subject.id),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
      );
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    const record = this.byId.get(id);
    if (!record || record.tenant !== tenant) return { kind: "absent" };
    if (record.state !== "open") return { kind: "terminal", state: record.state };
    if (record.rounds.length !== expectedRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    if (record.rounds.length >= record.frame.budget.maxRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    const evaluation = round.verdict.evaluationId ? this.evaluations.get(round.verdict.evaluationId) : undefined;
    if (
      round.verdict.evaluationId &&
      (!evaluation ||
        evaluation.tenant !== tenant ||
        evaluation.campaignId !== id ||
        evaluation.reportedRound !== undefined ||
        evaluation.candidate?.scorecardId !== round.candidateScorecardId ||
        evaluation.baseline?.scorecardId !== round.baselineScorecardId)
    )
      throw new ConflictError("CONFLICT", {}, "round does not own an unreported evaluation");
    if (evaluation) this.evaluations.set(evaluation.id, { ...evaluation, reportedRound: round.seq });
    const rounds = [...record.rounds, round];
    this.byId.set(id, { ...record, rounds, updatedAt: round.at });
    if (events) this.events.push(...events);
    return { kind: "appended", seq: rounds.length };
  }

  // The `AdoptionOperationStore` half, on the same object: a single-process deployment has nothing to split.
  //
  // ⚠️ TENANT-SCOPED, like the campaign half above (arch-review 74, self-review). All four of these ignored
  // the tenant while `PgAdoptionOperationStore` filters on it — so the twin was more permissive than
  // production on the one axis where that is worst, and no unit test could see a cross-workspace read
  // (rule `testing`: a guard the in-memory twin does not have is a guard no unit test can see).
  async forCampaign(tenant: string, campaignId: string): Promise<AdoptionOperation | undefined> {
    const op = this.adoptions.get(campaignId);
    return op !== undefined && op.tenant === tenant ? op : undefined; // another workspace's reads as nonexistent
  }

  async markRegistered(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    registeredVersion: string,
    events?: OutboxEvent[],
  ): Promise<"registered" | "already_registered" | "no_such_operation" | "proof_mismatch"> {
    const op = await this.forCampaign(tenant, campaignId);
    if (op === undefined) return "no_such_operation";
    if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
    if (op.state !== "decided") return "already_registered";
    this.adoptions.set(campaignId, { ...op, state: "registered", registeredVersion });
    if (events) this.events.push(...events); // same write, same twin behaviour as the Pg CTE (E0)
    return "registered";
  }

  // The code debt, paid — the same decisions the Pg statement makes, so a unit test sees the refusal production
  // would give: owed only, registered bytes only, this proof only.
  async markMerged(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    merged: { sha: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"merged" | "already_merged" | "no_code_debt" | "not_registered" | "no_such_operation" | "proof_mismatch"> {
    const op = await this.forCampaign(tenant, campaignId);
    if (op === undefined) return "no_such_operation";
    if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
    if (op.code === undefined) return "no_code_debt";
    if (op.code.state === "merged") return "already_merged";
    if (op.state === "decided") return "not_registered";
    this.adoptions.set(campaignId, {
      ...op,
      code: { ...op.code, state: "merged", mergedSha: merged.sha, mergedAt: merged.at },
    });
    if (events) this.events.push(...events);
    return "merged";
  }

  // Scheduling lives beside the operation rather than inside it, because it is not a thing the adoption did
  // — the lifecycle vocabulary stays `decided | registered | completed` (migration 0201 says why).
  private readonly nextAttemptAt = new Map<string, string>();
  private readonly lastOutcome = new Map<string, string>();

  async forIssue(tenant: string, issueId: string): Promise<AdoptionOperation[]> {
    return [...this.adoptions.values()].filter((op) => op.tenant === tenant && op.proof.issueId === issueId);
  }

  // The sweep's worklist, deployment-wide and DUE-first — the Pg twin's semantics exactly, including that it
  // is deliberately NOT tenant-scoped (the reconciler owns the debt for the process, and each row carries its
  // own tenant for the write it drives).
  //
  // Due-first rather than oldest-first, for the reason migration 0201 gives: nothing the reconciler does to a
  // row it cannot complete moves its age, so oldest-first lets a hundred unfinishable rows hold the head of
  // the list for ever while a newer completable one is never read.
  async registeredOlderThan(olderThan: string, limit: number): Promise<AdoptionOperation[]> {
    return [...this.adoptions.values()]
      .filter(
        (op) =>
          op.state === "registered" &&
          op.updatedAt < olderThan &&
          (this.nextAttemptAt.get(op.operationId) ?? "") <= olderThan,
      )
      .sort(
        (a, b) =>
          (this.nextAttemptAt.get(a.operationId) ?? "").localeCompare(this.nextAttemptAt.get(b.operationId) ?? "") ||
          a.updatedAt.localeCompare(b.updatedAt),
      )
      .slice(0, limit);
  }

  // What an examination that could not complete writes back. `updatedAt` is deliberately untouched: it
  // records when the DEBT started, and moving it would make an old unfinishable row look young.
  async deferCompletion(input: {
    tenant: string;
    campaignId: string;
    outcome: "open" | "unknown" | "orphaned";
    nextAttemptAt: string;
  }): Promise<boolean> {
    const op = await this.forCampaign(input.tenant, input.campaignId);
    if (op === undefined || op.state !== "registered") return false;
    this.nextAttemptAt.set(op.operationId, input.nextAttemptAt);
    this.lastOutcome.set(op.operationId, input.outcome);
    return true;
  }

  async markCompleted(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    events?: OutboxEvent[],
  ): Promise<"completed" | "already_completed" | "not_registered" | "no_such_operation" | "proof_mismatch"> {
    const op = await this.forCampaign(tenant, campaignId);
    if (op === undefined) return "no_such_operation";
    if (contentDigest(op.proof) !== proofDigest) return "proof_mismatch";
    if (op.state === "completed") return "already_completed";
    // `registered` only: an adoption whose registry write never landed has no intent to settle.
    if (op.state !== "registered") return "not_registered";
    this.adoptions.set(campaignId, { ...op, state: "completed" });
    if (events) this.events.push(...events);
    return "completed";
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
    adoption?: AdoptionOperation,
  ): Promise<CampaignCloseOutcome> {
    const record = this.byId.get(id);
    if (!record || record.tenant !== tenant) return { kind: "absent" };
    if (record.state !== "open") return { kind: "already", state: record.state };
    // The gate answer being closed was computed over exactly `expectedRounds` rounds — a round that landed
    // since makes the answer stale, and closing over it would record a settlement the record's own gate,
    // recomputed, would refuse.
    if (record.rounds.length !== expectedRounds)
      return { kind: "conflict", expected: expectedRounds, actual: record.rounds.length };
    this.byId.set(id, { ...record, state, close, updatedAt: close.at });
    // …and the authorization the close owes, written with it. One process, so "the same transaction" is the
    // same statement; what matters is that a refused close (every branch above) writes neither. Once only:
    // a campaign adopts once, so an at-least-once settle converges rather than minting a second one.
    if (adoption !== undefined && !this.adoptions.has(adoption.proof.campaignId))
      this.adoptions.set(adoption.proof.campaignId, adoption);
    if (events) this.events.push(...events);
    return { kind: "closed" };
  }

  // Test/dev inspection of the outbox half — the Pg impl's equivalent is the platform-events table.
  outbox(): OutboxEvent[] {
    return [...this.events];
  }
}

interface CampaignRow {
  id: string;
  tenant: string;
  issue_id: string;
  frame: unknown;
  frame_digest: string;
  rounds: unknown;
  state: string;
  close: unknown;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

function rowToRecord(row: CampaignRow): EvolutionCampaignRecord {
  return EvolutionCampaignRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    issueId: row.issue_id,
    frame: row.frame,
    frameDigest: row.frame_digest,
    rounds: row.rounds,
    state: row.state,
    ...(row.close !== null && row.close !== undefined ? { close: row.close } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

const COLUMNS = "(id, tenant, issue_id, frame, frame_digest, rounds, state, close, created_by, created_at, updated_at)";
const VALUES = "($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)";

export class PgEvolutionCampaignStore implements EvolutionCampaignStore {
  constructor(private readonly client: SqlClient) {}

  async createEvidenceGrant(grant: CampaignEvidenceGrant): Promise<CampaignEvidenceGrant> {
    const { rows } = await this.client.query<{ document: unknown }>(
      "INSERT INTO everdict_campaign_evidence_grants (token_hash, document) VALUES ($1,$2::jsonb) RETURNING document",
      [grant.tokenHash, JSON.stringify(grant)],
    );
    if (!rows[0]) throw new ConflictError("CONFLICT", {}, "evidence grant was not persisted");
    return CampaignEvidenceGrantSchema.parse(rows[0].document);
  }
  async evidenceGrant(tokenHash: string): Promise<CampaignEvidenceGrant | undefined> {
    const { rows } = await this.client.query<{ document: unknown }>(
      "SELECT document FROM everdict_campaign_evidence_grants WHERE token_hash=$1",
      [tokenHash],
    );
    return rows[0] ? CampaignEvidenceGrantSchema.parse(rows[0].document) : undefined;
  }

  private async evaluations(tenant: string): Promise<CampaignEvaluation[]> {
    const { rows } = await this.client.query<{ document: unknown }>(
      "SELECT document FROM everdict_campaign_evaluations WHERE tenant=$1",
      [tenant],
    );
    return rows.map((r) => CampaignEvaluationSchema.parse(r.document));
  }

  async family(tenant: string, campaignId: string): Promise<ExperimentFamily | undefined> {
    const { root } = familyMembers(campaignId, await this.list(tenant));
    const { rows } = await this.client.query<{ document: unknown }>(
      "SELECT document FROM everdict_experiment_families WHERE tenant=$1 AND id=$2",
      [tenant, root.id],
    );
    return rows[0] ? ExperimentFamilySchema.parse(rows[0].document) : undefined;
  }

  async evaluationForScorecard(tenant: string, scorecardId: string): Promise<CampaignEvaluation | undefined> {
    const { rows } = await this.client.query<{ document: unknown }>(
      "SELECT document FROM everdict_campaign_evaluations WHERE tenant=$1 AND (document->'baseline'->>'scorecardId'=$2 OR document->'candidate'->>'scorecardId'=$2)",
      [tenant, scorecardId],
    );
    return rows[0] ? CampaignEvaluationSchema.parse(rows[0].document) : undefined;
  }

  async reserveEvaluation(input: ReserveCampaignEvaluation) {
    return withTransaction(this.client, "reserve held-out evaluation", async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-family:${input.tenant}`]);
      const store = new PgEvolutionCampaignStore(tx);
      // Lock the campaign against close before checking its state and binding a second arm.
      await tx.query("SELECT id FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2 FOR UPDATE", [
        input.tenant,
        input.campaignId,
      ]);
      const records = await store.list(input.tenant);
      const result = reserveInFamily(
        input,
        records,
        await store.family(input.tenant, input.campaignId),
        await store.evaluations(input.tenant),
      );
      await tx.query(
        "INSERT INTO everdict_experiment_families (tenant,id,document) VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant,id) DO UPDATE SET document=EXCLUDED.document",
        [input.tenant, result.family.id, JSON.stringify(result.family)],
      );
      await tx.query(
        "INSERT INTO everdict_campaign_evaluations (tenant,id,campaign_id,family_id,document) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant,id) DO UPDATE SET document=EXCLUDED.document",
        [input.tenant, result.evaluation.id, input.campaignId, result.family.id, JSON.stringify(result.evaluation)],
      );
      return { kind: result.kind, evaluation: result.evaluation, scorecardId: result.scorecardId };
    });
  }

  async create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    if (record.frame.continues) {
      await withTransaction(this.client, "reserve experiment family budget", async (tx) => {
        // A separate statement after the lock sees the preceding creator's committed reservation.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-family:${record.tenant}`]);
        const store = new PgEvolutionCampaignStore(tx);
        assertFamilyCapacity(record, await store.list(record.tenant), await store.evaluations(record.tenant));
        await store.insert(record, events);
      });
      return;
    }
    await this.insert(record, events);
  }

  private async insert(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [
      record.id,
      record.tenant,
      record.issueId,
      JSON.stringify(record.frame),
      record.frameDigest,
      JSON.stringify(record.rounds),
      record.state,
      record.close !== undefined ? JSON.stringify(record.close) : null,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
    ];
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_evolution_campaigns ${COLUMNS} VALUES ${VALUES}`, base);
  }

  async get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined> {
    const { rows } = await this.client.query<CampaignRow>(
      "SELECT * FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  // Filtered IN THE QUERY, never after it: a limited page filtered afterwards lets one team's rows push
  // everyone else's off it (the same reasoning the run list already carries).
  async list(tenant: string, subject?: CampaignSubjectRef): Promise<EvolutionCampaignRecord[]> {
    // Every narrowing is a predicate IN THE STATEMENT — the team ceiling (arch-review 76) and the subject
    // (evolution-routing-spec.md §5) alike; a page filtered after the read lets one filter's rows push
    // another's off it. No ceiling = no team predicate (`undefined` means "nothing hidden", never "sees nothing").
    const where = ["tenant=$1"];
    const params: unknown[] = [tenant];
    if (subject !== undefined) {
      params.push(subject.type, subject.id);
      where.push(`frame->'subject'->>'type' = $${params.length - 1}`, `frame->'subject'->>'id' = $${params.length}`);
    }
    const { rows } = await this.client.query<CampaignRow>(
      `SELECT * FROM everdict_evolution_campaigns WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
      params,
    );
    return rows.map(rowToRecord);
  }

  async appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    if (round.verdict.evaluationId)
      return withTransaction(this.client, "report evaluation and append round", async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-family:${tenant}`]);
        const { rows } = await tx.query<{ document: unknown }>(
          "SELECT document FROM everdict_campaign_evaluations WHERE tenant=$1 AND id=$2 FOR UPDATE",
          [tenant, round.verdict.evaluationId],
        );
        const evaluation = rows[0] ? CampaignEvaluationSchema.parse(rows[0].document) : undefined;
        if (
          !evaluation ||
          evaluation.campaignId !== id ||
          evaluation.reportedRound !== undefined ||
          evaluation.baseline?.scorecardId !== round.baselineScorecardId ||
          evaluation.candidate?.scorecardId !== round.candidateScorecardId
        )
          throw new ConflictError("CONFLICT", {}, "round does not own an unreported evaluation");
        const result = await new PgEvolutionCampaignStore(tx).appendRows(tenant, id, round, expectedRounds, events);
        if (result.kind === "appended")
          await tx.query("UPDATE everdict_campaign_evaluations SET document=$3::jsonb WHERE tenant=$1 AND id=$2", [
            tenant,
            evaluation.id,
            JSON.stringify({ ...evaluation, reportedRound: round.seq }),
          ]);
        return result;
      });
    return this.appendRows(tenant, id, round, expectedRounds, events);
  }

  private async appendRows(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome> {
    // One statement: the CAS UPDATE, the outbox insert gated on it, and the landed count read back — the
    // decision consumes the write's answer rather than assuming it (rule `protocol`, conditional writes).
    const base = [tenant, id, JSON.stringify(round), round.at, expectedRounds];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ n: number | string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET rounds = rounds || $3::jsonb, updated_at = $4::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $5
           AND jsonb_array_length(rounds) < (frame->'budget'->>'maxRounds')::int
         RETURNING jsonb_array_length(rounds) AS n
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }
       SELECT n FROM upd`,
      [...base, ...(ev?.params ?? [])],
    );
    const n = rows[0]?.n;
    if (n !== undefined) return { kind: "appended", seq: Number(n) };
    // The write refused — read back WHY, so the caller gets a nameable refusal rather than a shrug.
    const { rows: readback } = await this.client.query<{ state: string; n: number | string }>(
      "SELECT state, jsonb_array_length(rounds) AS n FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    if (row.state !== "open") return { kind: "terminal", state: row.state as CampaignState };
    return { kind: "conflict", expected: expectedRounds, actual: Number(row.n) };
  }

  async close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
    adoption?: AdoptionOperation,
  ): Promise<CampaignCloseOutcome> {
    const base = [tenant, id, state, JSON.stringify(close), close.at, expectedRounds];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    // ── THE AUTHORIZATION RIDES THE CLOSE (arch-review 71 P0-evolution) ────────────────────────────
    //
    // `adopted` and "somebody owes a registration" are one durable fact or the settle-then-crash window is
    // exactly the hole this operation exists to close. It joins the SAME statement — guarded by
    // `EXISTS (SELECT 1 FROM upd)` like the outbox rows, so a refused close (already settled, or a round
    // landed since the gate's read) authorizes nothing.
    //
    // `ON CONFLICT DO NOTHING` on (tenant, campaign_id): a campaign adopts ONCE, so an at-least-once settle
    // converges rather than minting a second authorization.
    const adoptParams = adoption
      ? [
          adoption.operationId,
          JSON.stringify(adoption.proof),
          adoption.state,
          adoption.createdAt,
          adoption.code !== undefined ? JSON.stringify(adoption.code) : null,
        ]
      : [];
    const adoptOffset = base.length + (ev?.params.length ?? 0);
    const { rows } = await this.client.query<{ id: string }>(
      `WITH upd AS (
         UPDATE everdict_evolution_campaigns
         SET state = $3, close = $4::jsonb, updated_at = $5::timestamptz
         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $6
         RETURNING id
       )${
         ev !== undefined
           ? `, ev AS (
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v
         WHERE EXISTS (SELECT 1 FROM upd)
       )`
           : ""
       }${
         adoption !== undefined
           ? `, adopt AS (
         INSERT INTO everdict_adoption_operations
           (operation_id, tenant, campaign_id, proof, state, created_at, updated_at, code)
         SELECT $${adoptOffset + 1}, $1, $2, $${adoptOffset + 2}::jsonb, $${adoptOffset + 3},
                $${adoptOffset + 4}::timestamptz, $${adoptOffset + 4}::timestamptz, $${adoptOffset + 5}::jsonb
         WHERE EXISTS (SELECT 1 FROM upd)
         ON CONFLICT (tenant, campaign_id) DO NOTHING
       )`
           : ""
       }
       SELECT id FROM upd`,
      [...base, ...(ev?.params ?? []), ...adoptParams],
    );
    if (rows[0] !== undefined) return { kind: "closed" };
    // The write refused — read back WHY: closed already, a round landed since the gate's read, or gone.
    const { rows: readback } = await this.client.query<{ state: string; n: number | string }>(
      "SELECT state, jsonb_array_length(rounds) AS n FROM everdict_evolution_campaigns WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    const row = readback[0];
    if (row === undefined) return { kind: "absent" };
    if (row.state !== "open") return { kind: "already", state: row.state as CampaignState };
    return { kind: "conflict", expected: expectedRounds, actual: Number(row.n) };
  }
}
