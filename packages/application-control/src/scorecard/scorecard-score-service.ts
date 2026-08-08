import {
  BadRequestError,
  type CaseResult,
  ConflictError,
  type Dataset,
  type EvalCase,
  NotFoundError,
  SCORING_PASS_STALE_MS,
  type ScoringPass,
  type ScorecardRecord,
} from "@everdict/contracts";
import {
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  judgeGradeable,
  summarizeScorecard,
  verdictSummaryOf,
} from "@everdict/domain";
import { appendScoringRevision, resolvePolicyResolution } from "@everdict/domain";
import { childKey, hasMeasuredJudgeVerdict, stripJudgeScores } from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { ScorecardScoringDeps } from "./scorecard-deps.js";
import { analysisBundle, offloadAnalysis } from "./scorecard-observability.js";
import { sealJudgeClosure } from "./scorecard-plan.js";

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
    private readonly deps: ScorecardScoringDeps,
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
    // The PERSISTED pass marker (arch-review 7 P0) — set BEFORE anything strips, cleared in the settle
    // write. Three jobs in one row: the cross-replica one-pass-at-a-time guard (the Set above is
    // process-local), the boundary trust readers refuse on (the plane between revisions — including the
    // plane a FAILED/abandoned Temporal pass left broken, which used to stay silently readable), and the
    // pass-start judge closure the finalized revision will record. A live fresh pass refuses; a failed or
    // stale one is TAKEN OVER — crash residue must never wedge the record forever.
    const existing = record.scoringPass ?? undefined;
    if (
      existing !== undefined &&
      existing.status === "running" &&
      Date.parse(this.now()) - Date.parse(existing.startedAt) < SCORING_PASS_STALE_MS
    )
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, startedAt: existing.startedAt, targetRevision: existing.targetRevision },
        "A scoring pass is already in flight on this group — retry after it settles.",
      );
    const pass: ScoringPass = {
      targetRevision: (record.scoring?.at(-1)?.revision ?? 0) + 1,
      baseRevision: record.scoring?.at(-1)?.revision ?? 0,
      judges: await sealJudgeClosure(this.deps, input.tenant, pinned),
      startedAt: this.now(),
      ...(input.submittedBy !== undefined ? { startedBy: input.submittedBy } : {}),
      ...(this.deps.temporalScores && record.runIds?.length
        ? { workflowId: this.deps.temporalScores.workflowIdFor(record.id) }
        : {}),
      status: "running",
    };
    await this.deps.store.update(record.id, { scoringPass: pass, updatedAt: this.now() });
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

  // The Temporal pass's STRIP-FIRST step (arch-review 6, H4) — run ONCE per pass, before the first plan. The
  // worklist predicate (hasMeasuredJudgeVerdict) is id-only because the score plane cannot represent a judge
  // VERSION: with quality@1's measured verdicts in place, a quality@2 pass planned an EMPTY worklist and then
  // finalized — advertising the new version's sealed closure over the old version's judgments, zero re-judging
  // done. Stripping the selected judges' entire prior output first (persisted via the child-run write-back)
  // makes the predicate mean "judged in THIS pass" — the exact alignment the in-process track() gets by
  // stripping before it judges. Idempotent: re-stripping a stripped plane changes nothing, so an activity
  // retry is safe; the ONCE-per-pass discipline is the workflow's (the `prepared` flag threads through
  // continue-as-new — re-running this after cases were re-judged would erase this pass's own work). Only
  // gradeable results strip — a classified failure's placeholder rows are starvation evidence, not judgment.
  async prepareScore(id: string, judges: Array<{ id: string; version: string }>): Promise<{ stripped: number }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    if (!ScorecardBatch.from(record).canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, status: record.status },
        `only a succeeded group can be scored (status: ${record.status})`,
      );
    // Ensure the persisted pass marker exists BEFORE the strip (normally score() wrote it; a resumed
    // workflow whose marker was lost re-arms it here) — the strip is the moment the plane stops belonging
    // to a completed revision, and readers must be able to see that.
    if ((record.scoringPass ?? undefined) === undefined) {
      await this.deps.store.update(id, {
        scoringPass: {
          targetRevision: (record.scoring?.at(-1)?.revision ?? 0) + 1,
          baseRevision: record.scoring?.at(-1)?.revision ?? 0,
          judges: await sealJudgeClosure(this.deps, record.tenant, judges),
          startedAt: this.now(),
          status: "running",
        },
        updatedAt: this.now(),
      });
    }
    const results = record.scorecard?.results ?? [];
    const changed: CaseResult[] = [];
    for (const r of results) {
      if (!judgeGradeable(r)) continue;
      const scores = stripJudgeScores(r.scores, judges);
      if (scores.length !== r.scores.length) changed.push({ ...r, scores });
    }
    if (changed.length > 0) await this.writeBackScores(record, changed);
    return { stripped: changed.length };
  }

  // Idempotent plan: the child keys still MISSING at least one of the selected judges' verdicts. A re-attached
  // (or continued-as-new) workflow gets exactly the remainder — this is what makes a CP kill mid-pass resume
  // with zero duplicate judging. "Missing" is judged AFTER prepareScore cleared the selected judges' prior
  // rows, so the id-only predicate reads as "judged in THIS pass" (see prepareScore).
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
    // Pending = judge-gradeable (a classified failure starves the judge — its recovery is retry/re-collect,
    // not a scoring pass) AND missing a MEASURED verdict from at least one selected judge. Bare metric
    // presence is NOT "judged": an unmeasured placeholder row is the exact state a re-score exists to replace,
    // and reading it as done made the Temporal pass a no-op on its own worklist.
    const missing = results.filter((r) => judgeGradeable(r) && !judges.every((j) => hasMeasuredJudgeVerdict(r, j.id)));
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
    // Same predicate as planScore: a measured verdict per selected judge = done; an unmeasured placeholder
    // is not. A non-gradeable case (classified failure) is skipped — its recovery is not a scoring pass.
    if (!judgeGradeable(result) || judges.every((j) => hasMeasuredJudgeVerdict(result, j.id)))
      return { scored: false, skipped: true };
    // Strip the selected judges' ENTIRE prior output — verdicts, criterion children, placeholders — so the
    // re-score replaces rather than accretes (the exact-name strip left stale judge:<id>:<criterion> rows
    // alive next to fresh ones, compounding on every pass).
    const single: CaseResult = { ...result, scores: stripJudgeScores(result.scores, judges) };
    const dataset = await this.effectiveDataset(record, [single]);
    const runIdOf = await this.childRunIdResolver(record);
    await this.scoring.applyJudges(record.tenant, dataset, [single], judges, record.runtime, submittedBy, runIdOf);
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
      // Re-scoring a judge REPLACES its previous output (idempotent by the judge:<id> prefix family — the
      // verdict AND its criterion children) — strip the selected judges' old scores, keep everything else
      // (graders, other judges) untouched. Same strip as the Temporal pass: two paths, one predicate.
      const results: CaseResult[] = scorecard.results.map((r) => ({
        ...r,
        scores: stripJudgeScores(r.scores, judges),
      }));
      const dataset = await this.effectiveDataset(record, results);
      const runIdOf = await this.childRunIdResolver(record);
      await this.scoring.applyJudges(record.tenant, dataset, results, judges, record.runtime, submittedBy, runIdOf);
      await this.writeBackScores(record, results);
      await this.aggregate(record, scorecard, results, judges, submittedBy);
    } catch (err) {
      // Best-effort visibility: a failed scoring pass never flips the (already settled) group — it leaves a step.
      const fresh = await this.deps.store.get(record.id).catch(() => undefined);
      if (!fresh) return;
      const message = err instanceof Error ? err.message : String(err);
      // The pass marker flips to FAILED and STAYS — the strip already mutated the plane, so readers must
      // keep refusing it (broken evidence is not a readable revision). A later pass takes the marker over.
      const failedPass = fresh.scoringPass ?? undefined;
      await this.deps.store
        .update(record.id, {
          ...(failedPass !== undefined
            ? { scoringPass: { ...failedPass, status: "failed" as const, failedAt: this.now(), failure: message } }
            : {}),
          steps: [...(fresh.steps ?? []), { ts: this.now(), phase: "judges", status: "failed", message }],
          updatedAt: this.now(),
        })
        .catch(() => undefined);
    }
  }

  // Aggregate to the group through the domain transition — the scorecard.scored fact rides the E0 outbox.
  // Shared by the in-process pass (its own scored results) and the workflow finalize (the hydrated reload).
  // A re-score REWRITES SCORING IDENTITY, so this write also rewrites everything that describes it: the
  // manifest/orchestration judge views refresh to the merged effective set (replace-selected/keep-others —
  // the same semantics the write-back applies to the score plane itself), judgeModels recomputes over that
  // set (never a union with history), the analysis artifact re-freezes from THIS pass's plane, and the
  // append-only scoring ledger gains the pass's revision. Before this, the record kept certifying the
  // submit-era judges over a plane a different judge had since re-scored.
  private async aggregate(
    record: ScorecardRecord,
    base: NonNullable<ScorecardRecord["scorecard"]>,
    results: CaseResult[],
    judges: Array<{ id: string; version: string }>,
    submittedBy: string | undefined,
  ): Promise<void> {
    const summary = summarizeScorecard({ ...base, results });
    const fresh = await this.deps.store.get(record.id);
    if (!fresh) return;
    // The selected judges' closure, sealed by the SAME function submit uses (scorecard-plan sealJudgeClosure)
    // — two seals of "the judge closure" on one record must mean the same thing.
    const sealed = await sealJudgeClosure(this.deps, record.tenant, judges);
    const selectedIds = new Set(judges.map((j) => j.id));
    const mergedManifestJudges = [...(fresh.manifest?.judges ?? []).filter((j) => !selectedIds.has(j.id)), ...sealed];
    const mergedPins = [...(fresh.orchestration?.judges ?? []).filter((j) => !selectedIds.has(j.id)), ...judges];
    // CURRENT judge models — the merged effective set under the batch's own inline judge config. The pre-fix
    // union kept advertising a replaced judge's model as this record's judge forever.
    const judgeModels = await this.scoring.collectJudgeModels(record.tenant, mergedPins, fresh.orchestration?.judge);
    // Re-freeze the analysis artifact from this pass's plane under the batch's own stamped policy — the
    // previous bundle describes scores that no longer exist. An unresolvable stamp skips the re-freeze
    // (re-judging history under today's ladder would ship a rewritten file); the revision then carries no
    // analysisRef, which is the honest record of "this pass has no frozen artifact".
    const resolution = resolvePolicyResolution(fresh.verdictPolicy, fresh.manifest?.verdictPolicy);
    const analysisRef =
      resolution.status === "unresolvable"
        ? undefined
        : await offloadAnalysis(
            this.deps,
            record.id,
            analysisBundle(
              {
                scorecardId: record.id,
                dataset: `${fresh.dataset.id}@${fresh.dataset.version}`,
                harness: `${fresh.harness.id}@${fresh.harness.version}`,
              },
              summary,
              results,
              resolution.policy,
            ),
          );
    const scoring = appendScoringRevision(fresh.scoring, {
      kind: "rescore",
      judges: sealed,
      results,
      ...(analysisRef ? { analysisRef } : {}),
      createdAt: this.now(),
      ...(submittedBy !== undefined ? { createdBy: submittedBy } : {}),
    });
    const extras: ScorecardOutcomeExtras = {
      summary,
      // The revision boundary CLOSES in this same write: the pass marker clears exactly when the revision
      // appends — there is no instant where the plane is both readable and between revisions.
      scoringPass: null,
      // The stamped-policy verdict aggregate follows the judgment (arch-review 7 §4). An unresolvable stamp
      // skips the refresh like the analysis re-freeze does — the STALE aggregate stays detectable, because
      // its policyDigest no longer matches the record's verdictPolicy stamp era; never silently re-derived.
      ...(resolution.status === "unresolvable" ? {} : { verdictSummary: verdictSummaryOf(results, resolution.policy) }),
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      scoring,
      ...(analysisRef ? { analysisRef } : {}),
      ...(fresh.manifest ? { manifest: { ...fresh.manifest, judges: mergedManifestJudges } } : {}),
      ...(fresh.orchestration ? { orchestration: { ...fresh.orchestration, judges: mergedPins } } : {}),
      // Embed-mode groups (no child runs) keep their embed as the score carrier; dedup groups carry runIds
      // and hydrate from the (re-scored) children, so the embed stays out of the row.
      ...(record.runIds?.length ? {} : { scorecard: { ...base, results } }),
    };
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
  // childKey→run-id resolver for a scoring pass — the same children read writeBackScores does, folded to ids, so
  // the judge's own execution can seal as a judge:<id> plane on the child it judged. Best-effort: no run store /
  // failed lookup = undefined (judges still run and meter; no evidence plane lands). Result-less children are
  // excluded for the same shadowing reason writeBackScores excludes them.
  private async childRunIdResolver(
    record: ScorecardRecord,
  ): Promise<((caseId: string, trial?: number) => string | undefined) | undefined> {
    const store = this.deps.runStore;
    if (!store || !record.runIds?.length) return undefined;
    try {
      const children = await store.list(record.tenant, { scorecardId: record.id });
      const byKey = new Map(
        children.filter((c) => c.result).map((c) => [childKey(c.caseId, c.result?.trial), c.id] as const),
      );
      return (caseId, trial) => byKey.get(childKey(caseId, trial));
    } catch {
      return undefined;
    }
  }

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
