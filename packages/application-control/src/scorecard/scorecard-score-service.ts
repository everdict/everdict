import {
  BadRequestError,
  type CaseResult,
  ConflictError,
  type Dataset,
  type EvalCase,
  NotFoundError,
  type ScorecardRecord,
} from "@everdict/contracts";
import { ScorecardBatch, type ScorecardOutcomeExtras, summarizeScorecard } from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import { type ScorecardServiceDeps, childKey } from "./scorecard-shared.js";

// Phase 2, detached (execution-model.md P2): apply judges over an EXISTING group's runs and re-write the
// aggregate — "re-score with a different judge" and "promote experiment → scorecard" are the same operation
// with different inputs. Phase 1 is never re-executed: scores attach to the child runs (write-back), the
// aggregate to the group, exactly the split the batch pipeline already lives by. Composed only by the
// ScorecardService facade (R2-b collaborator pattern).
export interface ScoreGroupInput {
  tenant: string;
  id: string;
  judges: Array<{ id: string; version: string }>;
  submittedBy?: string;
}

export class ScorecardScoreService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly scoring: ScoringService;
  private readonly getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
  private readonly pinJudges: (
    tenant: string,
    judges: Array<{ id: string; version: string }>,
  ) => Promise<Array<{ id: string; version: string }>>;
  // One in-flight scoring per group (single control-plane process — the same assumption as the batch rendezvous).
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: ScorecardServiceDeps,
    shared: {
      newId: () => string;
      now: () => string;
      scoring: ScoringService;
      getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
      pinJudges: (
        tenant: string,
        judges: Array<{ id: string; version: string }>,
      ) => Promise<Array<{ id: string; version: string }>>;
    },
  ) {
    this.newId = shared.newId;
    this.now = shared.now;
    this.scoring = shared.scoring;
    this.getRecord = shared.getRecord;
    this.pinJudges = shared.pinJudges;
  }

  // Validate + kick the async scoring; returns the (still unchanged) record — poll get until summary/judgeModels
  // move and the scorecard.scored fact lands. Guards: workspace scope (404), phase-1 completed (409 via the
  // domain guard), results present (400), judges non-empty (400), one scoring at a time per group (409).
  async score(input: ScoreGroupInput): Promise<ScorecardRecord> {
    if (input.judges.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: input.id }, "Scoring needs at least one judge.");
    const record = await this.getRecord(input.id); // hydrated — results come from the child runs when dedup-stored
    if (!record || record.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "Scorecard not found.");
    if (!ScorecardBatch.from(record).canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, status: record.status },
        `only a succeeded group can be scored (status: ${record.status})`,
      );
    if (!record.scorecard || record.scorecard.results.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: record.id }, "This group has no case results to score.");
    if (this.inFlight.has(record.id))
      throw new ConflictError("CONFLICT", { scorecard: record.id }, "A scoring pass is already in flight.");
    const pinned = await this.pinJudges(input.tenant, input.judges);
    // Score-on-Temporal (T-c): a durable score:<groupId> workflow owns the pass — re-scoring a large group
    // survives a CP restart with zero duplicate judging. Only runIds-backed groups route here (per-case
    // write-back is what makes the activities idempotent; an embed group has no per-case store, so it takes
    // the in-process pass). A running workflow = ConflictError from start (deterministic id is the dedup);
    // any OTHER start failure degrades gracefully to the in-process pass (same posture as batch submit).
    if (this.deps.temporalScores && record.runIds?.length) {
      try {
        await this.deps.temporalScores.start({
          groupId: record.id,
          judges: pinned,
          ...(input.submittedBy !== undefined ? { submittedBy: input.submittedBy } : {}),
        });
        return record;
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        // degrade: the workflow could not start (Temporal outage) — the pass must never silently hang
      }
    }
    this.inFlight.add(record.id);
    void this.track(record, record.scorecard, pinned, input.submittedBy).finally(() => this.inFlight.delete(record.id));
    return record;
  }

  // ── Score-on-Temporal internal bridge (worker activities → these three; the same pattern as the batch
  // plan/case/finalize). The unit is the (caseId, trial) child key — caseId alone is ambiguous under trials. ──

  // Idempotent plan: the child keys still MISSING at least one of the selected judges' verdicts. A re-attached
  // (or continued-as-new) workflow gets exactly the remainder — this is what makes a CP kill mid-pass resume
  // with zero duplicate judging.
  async planScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
  ): Promise<{ keys: string[]; concurrency: number }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    if (!ScorecardBatch.from(record).canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, status: record.status },
        `only a succeeded group can be scored (status: ${record.status})`,
      );
    const results = record.scorecard?.results ?? [];
    const missing = results.filter((r) => !judges.every((j) => r.scores.some((s) => s.metric === `judge:${j.id}`)));
    return {
      keys: missing.map((r) => childKey(r.caseId, r.trial)),
      concurrency: record.orchestration?.concurrency ?? 4,
    };
  }

  // Judge exactly one case and write its verdicts back to the child run. Idempotent: already fully judged →
  // skipped (the workflow's activity retry / a resumed pass re-calls this harmlessly).
  async scoreCase(
    id: string,
    key: string,
    judges: Array<{ id: string; version: string }>,
    submittedBy?: string,
  ): Promise<{ scored: boolean; skipped?: boolean }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    const result = (record.scorecard?.results ?? []).find((r) => childKey(r.caseId, r.trial) === key);
    if (!result) return { scored: false, skipped: true };
    if (judges.every((j) => result.scores.some((s) => s.metric === `judge:${j.id}`)))
      return { scored: false, skipped: true };
    const selected = new Set(judges.map((j) => `judge:${j.id}`));
    const single: CaseResult = { ...result, scores: result.scores.filter((s) => !selected.has(s.metric)) };
    const dataset = await this.effectiveDataset(record, [single]);
    await this.scoring.applyJudges(record.tenant, dataset, [single], judges, record.runtime, submittedBy);
    await this.writeBackScores(record, [single]);
    return { scored: true };
  }

  // Re-aggregate from the (now re-scored) children and settle through the rescore transition — the terminal
  // step of the workflow pass. Reloads hydrated state, so it sees exactly what the scoreCase activities wrote.
  async finalizeScore(id: string, judges: Array<{ id: string; version: string }>, submittedBy?: string): Promise<void> {
    const record = await this.getRecord(id);
    const base = record?.scorecard;
    if (!record || !base) return;
    await this.aggregate(record, base, base.results, judges, submittedBy);
  }

  private async track(
    record: ScorecardRecord,
    scorecard: NonNullable<ScorecardRecord["scorecard"]>,
    judges: Array<{ id: string; version: string }>,
    submittedBy: string | undefined,
  ): Promise<void> {
    try {
      // Re-scoring a judge REPLACES its previous verdicts (idempotent by natural key judge:<id>) — strip the
      // selected judges' old scores, keep everything else (graders, other judges) untouched.
      const selected = new Set(judges.map((j) => `judge:${j.id}`));
      const results: CaseResult[] = scorecard.results.map((r) => ({
        ...r,
        scores: r.scores.filter((s) => !selected.has(s.metric)),
      }));
      const dataset = await this.effectiveDataset(record, results);
      await this.scoring.applyJudges(record.tenant, dataset, results, judges, record.runtime, submittedBy);
      await this.writeBackScores(record, results);
      await this.aggregate(record, scorecard, results, judges, submittedBy);
    } catch (err) {
      // Best-effort visibility: a failed scoring pass never flips the (already settled) group — it leaves a step.
      const fresh = await this.deps.store.get(record.id).catch(() => undefined);
      if (!fresh) return;
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.store
        .update(record.id, {
          steps: [...(fresh.steps ?? []), { ts: this.now(), phase: "judges", status: "failed", message }],
          updatedAt: this.now(),
        })
        .catch(() => undefined);
    }
  }

  // Aggregate to the group through the domain transition — the scorecard.scored fact rides the E0 outbox.
  // Shared by the in-process pass (its own scored results) and the workflow finalize (the hydrated reload).
  private async aggregate(
    record: ScorecardRecord,
    base: NonNullable<ScorecardRecord["scorecard"]>,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
    submittedBy: string | undefined,
  ): Promise<void> {
    const summary = summarizeScorecard({ ...base, results });
    const newJudgeModels = await this.scoring.collectJudgeModels(record.tenant, judges, undefined);
    const judgeModels = [...new Set([...(record.judgeModels ?? []), ...newJudgeModels])].sort();
    const extras: ScorecardOutcomeExtras = {
      summary,
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      // Embed-mode groups (no child runs) keep their embed as the score carrier; dedup groups carry runIds
      // and hydrate from the (re-scored) children, so the embed stays out of the row.
      ...(record.runIds?.length ? {} : { scorecard: { ...base, results } }),
    };
    const fresh = await this.deps.store.get(record.id);
    if (!fresh) return;
    const transition = ScorecardBatch.from(fresh).rescore(
      extras,
      submittedBy !== undefined ? { actor: submittedBy } : {},
      this.now(),
    );
    const stamped = stampFacts(fresh.tenant, transition.facts, { newId: this.newId, now: this.now });
    await this.deps.store.update(
      record.id,
      transition.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
  }

  // The dataset judges align against: the registered one when it resolves; otherwise (ad-hoc experiments under
  // the _adhoc sentinel, trace-eval groups, a deleted dataset) synthesize prompt-shell cases from the results —
  // the same shape the ingest path scores dataset-less traces with.
  private async effectiveDataset(record: ScorecardRecord, results: CaseResult[]): Promise<Dataset> {
    try {
      return await this.deps.datasets.get(record.tenant, record.dataset.id, record.dataset.version);
    } catch {
      const shell = (caseId: string): EvalCase => ({
        id: caseId,
        env: { kind: "prompt" },
        task: "",
        graders: [],
        timeoutSec: 1800,
        tags: [],
      });
      return {
        id: record.dataset.id,
        version: record.dataset.version,
        tags: [],
        cases: [...new Set(results.map((r) => r.caseId))].map(shell),
      };
    }
  }

  // Reflect the re-scored results onto the child runs (phase 1's authoritative per-case record — get() hydrates
  // from them). No recording re-seal: phase 1 was not re-executed, so the sealed replay stays as it was.
  private async writeBackScores(record: ScorecardRecord, results: CaseResult[]): Promise<void> {
    const store = this.deps.runStore;
    if (!store || !record.runIds?.length) return;
    const children = await store.list(record.tenant, { scorecardId: record.id });
    // Only children WITH a result can receive a write-back — and a result-less child must not enter the map:
    // childKey(trial: undefined) collapses onto "#0", where the last result-less child would silently SHADOW
    // the real trial-0 child and make the write-back skip it.
    const byKey = new Map(
      children.filter((c) => c.result).map((c) => [childKey(c.caseId, c.result?.trial), c] as const),
    );
    for (const r of results) {
      const child = byKey.get(childKey(r.caseId, r.trial));
      if (!child?.result) continue;
      await store.update(child.id, {
        result: { ...child.result, scores: r.scores },
        updatedAt: this.now(),
      });
    }
  }
}
