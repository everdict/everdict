import {
  BadRequestError,
  type CaseCommitReceipt,
  type CaseResult,
  ConflictError,
  type Dataset,
  EXPERIMENT_ADHOC_REF,
  type EvalCase,
  NotFoundError,
  type RunRecord,
  SCORING_PASS_LEASE_MS,
  SCORING_PASS_RENEW_BEFORE_MS,
  type Score,
  ScoreSchema,
  type ScorecardRecord,
  type ScoringPass,
  TRACE_EVAL_REF,
  scoringPassReclaimable,
} from "@everdict/contracts";
import {
  CURRENT_STAGE_PARITY_VERSION,
  type ReceiptLedgerReading,
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  type ScoringStageParity,
  caseObservationDigest,
  contentDigest,
  inputObservationOf,
  judgeGradeable,
  nextScoringRevision,
  promoteStagedJudgments,
  scorePlaneDigest,
  sealedExecutionMessage,
  stagePromotionRefusal,
  stagePromotionSafe,
  summarizeScorecard,
  verdictSummaryOf,
  verifySealedCaseDocuments,
} from "@everdict/domain";
import { appendScoringRevision, resolvePolicyResolution } from "@everdict/domain";
import {
  childKey,
  isJudgeMetricOf,
  judgeAttemptsOf,
  judgePending,
  pendingJudgesFor,
  stampJudgeAttempts,
  stripJudgeScores,
} from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { JudgmentClaim, StagedJudgment } from "../ports/scoring-stage-store.js";
import { ExecutionPlan } from "./execution-plan.js";
import type { ScorecardScoringDeps } from "./scorecard-deps.js";
import { type AnalysisOffload, analysisBundle, offloadAnalysis } from "./scorecard-observability.js";
import { sealJudgeClosure } from "./scorecard-plan.js";

// How many disagreeing units a revision records by name. A pass disagreeing on thousands has a systemic
// fault the first few describe as well as all of them, and the revision is a record, not a log.
const PARITY_UNIT_SAMPLE = 50;

// The disagreeing units, bounded and honestly labelled (arch-review 17 P1-7).
function parityUnits(parity: ScoringStageParity): {
  missingFromStage: string[];
  mismatched: string[];
  orphaned: string[];
  truncated: boolean;
} {
  const cut = (rows: readonly string[]) => rows.slice(0, PARITY_UNIT_SAMPLE);
  return {
    missingFromStage: cut(parity.missingFromStage),
    mismatched: cut(parity.mismatched),
    orphaned: cut(parity.orphaned),
    truncated:
      parity.missingFromStage.length > PARITY_UNIT_SAMPLE ||
      parity.mismatched.length > PARITY_UNIT_SAMPLE ||
      parity.orphaned.length > PARITY_UNIT_SAMPLE,
  };
}

// ONE READ of a pass's stage, answering both questions asked of it at settle: how it COMPARED to the plane
// (the durable evidence the contract step is gated on) and what it CONTAINS (the rows a promotion merges).
// They are bundled because they must describe the same read — a second `staged()` call could observe a
// different stage, and the revision would then be certified by a report about rows its bytes did not come
// from.
interface StageObservation {
  parity: ScoringStageParity;
  staged: StagedJudgment[];
}

// One judge family's rows, as a STORAGE-PATH-INDEPENDENT value (arch-review 16 P1-6). Parsing normalizes the
// defaults a jsonb round-trip does not carry; sorting by metric removes an ordering that is not content; and
// `contentDigest` is canonical over key order. Anything less compares the transport, not the judgment.
function canonicalScores(scores: readonly Score[]): string {
  const parsed = scores.map((s) => ScoreSchema.parse(s)).sort((a, b) => a.metric.localeCompare(b.metric));
  return contentDigest(parsed);
}

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

  // HOW FAR THIS PROCESS'S CLOCK IS FROM THE DATABASE'S (arch-review 19 P1).
  //
  // The lease's END is stamped by the database and its EXPIRY is judged by the database — both correct. What
  // was left on the application's clock is the decision of WHEN TO RENEW, and a replica running slow reads
  // "plenty of time left" while the database considers the lease nearly gone. Nothing is corrupted (the
  // fences refuse the stale writer), but a healthy pass gets taken over and its provider calls are paid for
  // twice, which is the expensive kind of harmless.
  //
  // Every stamped renewal answers the offset for free: the database wrote `now() + lease`, so the difference
  // between that and this process's own `now() + lease` IS the skew. Measured on each renewal and applied to
  // the due check, which puts the producer, the judge and the scheduler of a lease in ONE clock frame.
  private clockOffsetMs = 0;

  private observeClockOffset(stampedLeaseUntil: string | undefined): void {
    if (stampedLeaseUntil === undefined) return;
    const stamped = Date.parse(stampedLeaseUntil);
    if (Number.isNaN(stamped)) return;
    this.clockOffsetMs = stamped - (Date.parse(this.now()) + SCORING_PASS_LEASE_MS);
  }

  // This process's clock, corrected into the database's frame.
  private databaseNow(): number {
    return Date.parse(this.now()) + this.clockOffsetMs;
  }

  // The lease a claim/renewal grants. The owner extends it while it works, so the window bounds "how long
  // since this pass last proved it was alive" — never "how long a pass may legitimately run".
  private leaseUntil(): string {
    return new Date(Date.parse(this.now()) + SCORING_PASS_LEASE_MS).toISOString();
  }

  // Renew while working (per case / per activity). Guarded by the pass IDENTITY: a pass that was TAKEN OVER
  // cannot extend a lease it no longer holds — the renewal simply misses, which is also how the owner finds
  // out. Returns false when this pass no longer owns the marker; callers stop rather than keep writing.
  private async renewLease(id: string, pass: ScoringPass): Promise<boolean> {
    // Keyed on `passId`, never on `epoch` (arch-review 10 §14). The epoch used to gate this, which quietly
    // made a diagnostic counter decide whether a lease was renewable at all — and a marker with a passId but
    // no epoch (every marker a future writer mints once epoch is dropped) would have skipped renewal
    // entirely. The authority is the identity; every other field describes it.
    if (pass.passId === undefined) return true; // legacy marker: nothing to renew against, nothing to fence
    // Still comfortably held → no write. Renewing on every case would cost a write per judgment for no
    // added safety; the fence on the write itself is what actually refuses a superseded pass.
    if (
      pass.leaseUntil !== undefined &&
      Date.parse(pass.leaseUntil) - this.databaseNow() > SCORING_PASS_RENEW_BEFORE_MS
    )
      return true;
    // The CAS is the authority — no pre-read to disagree with it. A miss means the epoch moved, i.e. this
    // pass was taken over, which is exactly what the caller needs to know.
    const renewed: Awaited<ReturnType<typeof this.deps.store.update>> = await this.deps.store.update(
      id,
      { scoringPass: { ...pass, leaseUntil: this.leaseUntil(), heartbeatAt: this.now() }, updatedAt: this.now() },
      undefined,
      // The STORE stamps the lease's end from the clock that will later judge it expired (arch-review 10 P1).
      // The `leaseUntil` above is the fallback a store without the capability keeps using; where the
      // capability exists it is overwritten, and a fast replica can no longer mint a lease the database
      // considers already dead.
      { expectScoringPassId: pass.passId ?? null, stampScoringLeaseSeconds: SCORING_PASS_LEASE_MS / 1000 },
    );
    this.observeClockOffset(renewed?.scoringPass?.leaseUntil);
    return renewed !== undefined;
  }

  // …AND THE PASS OWNS WHAT THE ACTIVITY MAY DO TO IT (arch-review 17 P1-5). Every internal scoring call
  // carries BOTH a passId and a judge selection, so the caller re-declares the operation its token authorized
  // — and nothing compared the two. A plumbing regression or a mistaken internal caller could present pass A's
  // token with judge B's selection, and every guard would pass: it would strip and re-judge a family the pass
  // never sealed, on a plane the pass owns.
  //
  // The marker already carries the sealed closure, so the selection has ONE owner and the activity's copy is
  // an assertion to be checked, not a second source. Compared on (id, version) as a SET — the closure carries
  // more (spec digests, nested pins), and order is not identity.
  private assertPassSelection(
    record: ScorecardRecord,
    pass: ScoringPass,
    judges: ReadonlyArray<{ id: string; version: string }>,
  ): void {
    const key = (rows: ReadonlyArray<{ id: string; version: string }>) =>
      JSON.stringify([...rows].map((j) => [j.id, j.version]).sort());
    // A marker sealed before closures were recorded has nothing to compare against; asserting on an empty
    // seal would refuse every in-flight legacy pass. Absence is a generation gap, not agreement.
    if (pass.judges === undefined || pass.judges.length === 0) return;
    if (key(pass.judges) === key(judges)) return;
    throw new ConflictError(
      "CONFLICT",
      { scorecard: record.id, passId: pass.passId },
      "this scoring activity presented a judge selection its pass does not own — the pass sealed a different set, and a token may not authorize an operation it never described.",
    );
  }

  // The pass an activity is allowed to act as. The cheap early-out before doing work — NOT the guarantee
  // (between this read and a write the winner can settle, which is why every write also carries the fence).
  //  · marker absent  → refuse. The pass settled or was taken over; acting now would mutate finished evidence.
  //  · passId given   → it must BE the owner, else this activity belongs to a superseded pass.
  //  · passId absent  → REFUSE (arch-review 9 P0). This used to adopt the live marker for in-flight legacy
  //                     workflows, and that tolerance turned a plumbing bug into a fence bypass: the
  //                     production adapter silently dropped passId, so EVERY activity arrived anonymous and
  //                     adopted whatever pass currently owned the marker — including a pass that had taken
  //                     over from it. An anonymous writer cannot be fenced, so it is refused. A workflow
  //                     in flight across the deploy fails visibly, its marker flips failed, and the next
  //                     pass takes over — a bounded, observable outcome instead of a silent bypass.
  private async owningPass(record: ScorecardRecord, passId: string | undefined): Promise<ScoringPass> {
    const live = record.scoringPass ?? undefined;
    if (!live)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, passId },
        "no scoring pass owns this group's score plane — it settled or was taken over; refusing to mutate a completed revision.",
      );
    if (passId === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, owner: live.passId },
        "this scoring activity presented no pass identity — an anonymous writer cannot be fenced, so it is refused (the caller must carry the passId its claim minted).",
      );
    if (live.passId !== passId)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, passId, owner: live.passId },
        "this scoring pass no longer owns the group's score plane — a newer pass took it over.",
      );
    // …and a pass that was DECLARED DEAD has no authority left (arch-review 17 P0-3). Identity says who this
    // is; status says whether it may still act. `failScore` flips the marker precisely so a workflow that
    // died terminally stops writing — and until now nothing enforced that: a late activity of a failed pass
    // matched on passId alone and wrote its judgment, and a late finalize appended a revision over a plane
    // whose owner had already been declared abandoned. The store fences enforce the same predicate, which is
    // what actually closes the check→write window; this is the early, legible refusal.
    if (live.status !== "running")
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, passId, status: live.status },
        "this scoring pass was declared dead — its authority is revoked, so it may not write again. A takeover will re-score the group.",
      );
    return live;
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
    // A LIVE pass owns the plane — however long it has been running. Staleness is a LEASE question, not an
    // age question: a 1000-case pass behind a rate-limited provider legitimately outlives any fixed window,
    // and taking it over because it is "old" shoots a working pass and puts two writers on one plane.
    if (existing !== undefined && !scoringPassReclaimable(existing, this.now()))
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id, startedAt: existing.startedAt, targetRevision: existing.targetRevision },
        "A scoring pass is already in flight on this group — retry after it settles.",
      );
    const passId = this.newId();
    const pass: ScoringPass = {
      // Ownership, not a flag: `passId` is what every later write carries so the storage layer can refuse a
      // superseded writer, and `epoch` is what the claim below compare-and-swaps on so exactly one claimant
      // can ever hold it. Read-check-write was not a lock — two replicas both read an absent marker.
      passId,
      epoch: (existing?.epoch ?? 0) + 1,
      leaseUntil: this.leaseUntil(),
      heartbeatAt: this.now(),
      targetRevision: (record.scoring?.at(-1)?.revision ?? 0) + 1,
      baseRevision: record.scoring?.at(-1)?.revision ?? 0,
      judges: await sealJudgeClosure(this.deps, input.tenant, pinned),
      startedAt: this.now(),
      ...(input.submittedBy !== undefined ? { startedBy: input.submittedBy } : {}),
      ...(this.deps.temporalScores && record.runIds?.length
        ? { workflowId: this.deps.temporalScores.workflowIdFor(record.id, passId) }
        : {}),
      status: "running",
    };
    // THE CLAIM (arch-review 8 P0). Commits only if the marker still carries the epoch this caller read —
    // so a rival that claimed in between wins and this one is told, instead of silently overwriting its
    // marker and running a second pass over the same plane under the loser's sealed closure.
    const claimed = await this.deps.store.update(record.id, { scoringPass: pass, updatedAt: this.now() }, undefined, {
      expectScoringPassId: existing?.passId ?? null,
      // Taking over? Then the DATABASE must agree the marker is reclaimable. The check above used THIS
      // replica's clock, and a replica running fast would otherwise declare a healthy pass dead and start a
      // second judging run over the same plane — fenced, so not corrupting, but paid for twice.
      ...(existing !== undefined ? { expectScoringPassReclaimable: true } : {}),
      // …and the lease this claim is granted is stamped by that same clock. Half of one decision read off
      // the database's clock and the other half off this process's was the remaining drift.
      stampScoringLeaseSeconds: SCORING_PASS_LEASE_MS / 1000,
    });
    // The claim stamps a lease too, so it is the first chance to learn the skew — before any renewal is due.
    this.observeClockOffset(claimed?.scoringPass?.leaseUntil);
    if (claimed === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id },
        "another replica claimed the scoring pass for this group first — retry after it settles.",
      );
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
          passId,
        });
        return record;
      } catch (err) {
        if (err instanceof ConflictError) {
          // A workflow already occupies this pass's workflow id. Since the id is PASS-SCOPED this is now a
          // near-dead branch (a passId is minted per claim), but it is the branch that decides what happens
          // to a marker whose driver never started, so it stays and it fails CLOSED.
          //
          // It used to clear the marker to `null`, and that was the worst possible answer (arch-review 10
          // P0): this claim is typically a TAKEOVER of a stalled pass A, and A may have stripped the plane
          // and re-scored half of it before stalling. Clearing the marker makes that half-mutated plane
          // READABLE again — the analytics guard refuses only while a marker exists, so `null` walks a
          // mid-revision plane straight past the one gate that exists to stop it. The plane's damage is not
          // undone by dropping the note that says it is damaged.
          //
          // So the marker STAYS, flipped to `failed`: readers keep refusing (an abandoned plane is not
          // readable evidence), and the next pass TAKES IT OVER exactly as it takes over any other failed
          // pass. Guarded by our own identity, so a pass that claimed in the meantime is never clobbered.
          await this.deps.store
            .update(
              record.id,
              {
                scoringPass: {
                  ...pass,
                  status: "failed",
                  failedAt: this.now(),
                  failure: "the scoring workflow could not start — another execution already holds this pass's id",
                },
                updatedAt: this.now(),
              },
              undefined,
              { expectScoringPassId: pass.passId ?? null },
            )
            .catch(() => undefined);
          throw err;
        }
        // degrade: the workflow could not start (Temporal outage) — the pass must never silently hang
      }
    }
    this.inFlight.add(record.id);
    void this.track(record, record.scorecard, pinned, input.submittedBy, pass).finally(() =>
      this.inFlight.delete(record.id),
    );
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
  async prepareScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    passId?: string,
  ): Promise<{ stripped: number }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    if (!ScorecardBatch.from(record).canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, status: record.status },
        `only a succeeded group can be scored (status: ${record.status})`,
      );
    // The marker must ALREADY exist and belong to this pass. It used to be RE-ARMED here when absent, which
    // is the worst interleaving in the whole path: a superseded pass's late activity would mint a marker for
    // a pass nobody is running, re-open the revision boundary a settle had just closed, and then strip the
    // plane that the settled revision certifies. An absent marker means the pass settled or was taken over —
    // there is nothing left for this activity to do, and stripping would destroy finished evidence.
    const pass = await this.owningPass(record, passId);
    this.assertPassSelection(record, pass, judges);
    await this.renewLease(id, pass);
    const results = record.scorecard?.results ?? [];
    const changed: CaseResult[] = [];
    for (const r of results) {
      if (!judgeGradeable(r)) continue;
      const scores = stripJudgeScores(r.scores, judges);
      if (scores.length !== r.scores.length) changed.push({ ...r, scores });
    }
    // `stage: false` — a strip is not a judgment (arch-review 10 P1). Writing it to the stage made a staged
    // row mean "this pass touched this case", so the obvious promotion predicate (`a row exists → judged`)
    // would have been quietly wrong on every case the strip cleared and the pass never got to. The stage
    // holds what a pass PRODUCED; the carriers keep holding what it inherited.
    if (changed.length > 0) await this.writeBackScores(record, changed, pass, { stage: false });
    return { stripped: changed.length };
  }

  // Idempotent plan: the child keys still MISSING at least one of the selected judges' verdicts. A re-attached
  // (or continued-as-new) workflow gets exactly the remainder — this is what makes a CP kill mid-pass resume
  // with zero duplicate judging. "Missing" is judged AFTER prepareScore cleared the selected judges' prior
  // rows, so the id-only predicate reads as "judged in THIS pass" (see prepareScore).
  async planScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    passId?: string,
  ): Promise<{ keys: string[]; concurrency: number }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    if (!ScorecardBatch.from(record).canScore())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, status: record.status },
        `only a succeeded group can be scored (status: ${record.status})`,
      );
    // A superseded workflow must not keep planning the NEW owner's worklist and spawning activity retries
    // against it. Read-only, so this cannot corrupt a plane — it is refused because work nobody asked for
    // costs judge calls and hides the takeover from whoever is watching.
    const planPass = await this.owningPass(record, passId);
    // …and the SELECTION is the pass's too (arch-review 18 P1). This was the one of the four scoring entry
    // points left out: a mistaken caller could build a worklist for judges the pass never sealed, and
    // Temporal would then schedule activities that each conflict at `scoreCase` — refused eventually, and
    // only after the fan-out was paid for in scheduling and retries.
    this.assertPassSelection(record, planPass, judges);
    const results = record.scorecard?.results ?? [];
    // Pending = judge-gradeable (a classified failure starves the judge — its recovery is retry/re-collect,
    // not a scoring pass) AND at least one selected judge still has work to do here.
    //
    // "Work to do" is an ORCHESTRATION question, not a measurement one (arch-review 11 P0). Bare metric
    // presence is not "judged" — an unmeasured placeholder is the exact state a re-score exists to replace —
    // but neither is every unmeasured row still pending: a judge whose spec cannot be resolved writes
    // `retryable: false` on every attempt, so reading "no measured verdict" as "still to do" put those cases
    // back on the worklist at every `continueAsNew`, forever, paying a provider call each time. `judgePending`
    // separates the two: absent and retryable-under-budget are pending, terminal-unmeasured is done-without-a
    // -verdict, and every measurement surface keeps reading it as the non-verdict it is.
    const missing = results.filter((r) => judgeGradeable(r) && judgePending(r, judges));
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
    passId?: string,
    // The pass-global ordinal of this invocation (mig 0158/0159) — the arbitration token between two
    // invocations of one pass. `generation` comes from the workflow's continue-as-new count and `attempt`
    // from the activity context; the in-process pass has neither.
    claim?: JudgmentClaim,
  ): Promise<{ scored: boolean; skipped?: boolean }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    // Ownership first: a judgment produced by a superseded pass is work nobody asked for, and writing it
    // back would corrupt the live pass's plane. Renewing here is also what keeps a long, healthy pass alive
    // — the lease advances per case, so "still working" and "still owner" are the same statement.
    const pass = await this.owningPass(record, passId);
    this.assertPassSelection(record, pass, judges);
    if (!(await this.renewLease(id, pass)))
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, passId: pass.passId },
        "this scoring pass lost its lease — a newer pass owns the group's score plane.",
      );
    const result = (record.scorecard?.results ?? []).find((r) => childKey(r.caseId, r.trial) === key);
    if (!result) return { scored: false, skipped: true };
    if (!judgeGradeable(result)) return { scored: false, skipped: true };
    // The retry's unit is the JUDGE, not the case (arch-review 12). The planner asks "is this case pending";
    // this asks "which judges on it are", and only those are stripped and re-run. Using the case-level answer
    // for both meant one pending judge dragged its already-finished neighbours back through the provider —
    // deleting a measured verdict to re-derive it, and re-invoking a judge this very pass had declared
    // `terminal_unmeasured`. An invariant whose completion unit differs from its mutation unit is a statement
    // about the planner's beliefs, not about what happens.
    const pending = pendingJudgesFor(result, judges);
    if (pending.length === 0) return { scored: false, skipped: true };
    // What each PENDING judge had already tried here, read BEFORE the strip removes the evidence of it.
    // The attempt budget only binds if the count survives the strip that a re-score always performs.
    const priorAttempts = judgeAttemptsOf(result, pending);
    // Strip the PENDING judges' entire prior output — verdicts, criterion children, placeholders — so the
    // re-score replaces rather than accretes (the exact-name strip left stale judge:<id>:<criterion> rows
    // alive next to fresh ones, compounding on every pass). A judge that is done keeps its rows untouched.
    const single: CaseResult = { ...result, scores: stripJudgeScores(result.scores, pending) };
    const dataset = await this.effectiveDataset(record, [single]);
    const runIdOf = await this.childRunIdResolver(record);
    // The pass marker's sealed closure is the concretization source — every scoreCase activity of one pass
    // judges under the SAME resolution, even when `latest` moves between activities (I6).
    await this.scoring.applyJudges(
      record.tenant,
      dataset,
      [single],
      // …and only the PENDING judges are invoked. Passing the full selection here is what actually spent the
      // provider calls on judges that were already done.
      pending,
      record.runtime,
      submittedBy,
      runIdOf,
      pass.judges,
      undefined,
      // …AND WHICH INVOCATION OF IT (arch-review 51 Track C). The pass identity alone scoped the evidence
      // plane per revision (41 P0-audit), which is exactly as far as it goes: THIS path re-invokes one
      // (pass, case, judge) — an activity retry, a later round — and the winner among those invocations is
      // decided by the CLAIM at `stageJudgments` below, not by who sealed first. So invocation 1 could seal
      // `judge:J#P`, lose the claim, and still own the permanent evidence for invocation 2's score. The
      // claim rides into the emitter so each invocation writes its own plane and no seal is refused.
      pass.passId !== undefined ? { passId: pass.passId, ...(claim !== undefined ? { claim } : {}) } : undefined,
    );
    // Count the attempt onto whatever this produced. A verdict ends the counting; another unmeasured row
    // carries prior+1, so a judge that keeps failing the same way exhausts its budget and the pass can end.
    single.scores = stampJudgeAttempts(single.scores, pending, priorAttempts);
    // The STAGE still receives the whole selected-judge delta for this case: judges finished on an earlier
    // attempt belong in the same row as the one just re-run, because the row is what a promotion writes.
    await this.writeBackScores(record, [single], pass, {
      judges,
      ...(claim !== undefined ? { claim } : {}),
    });
    return { scored: true };
  }

  // Re-aggregate from the (now re-scored) children and settle through the rescore transition — the terminal
  // step of the workflow pass. Reloads hydrated state, so it sees exactly what the scoreCase activities wrote.
  async finalizeScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    submittedBy?: string,
    passId?: string,
    // How many cases the pass STOPPED re-planning (arch-review 15 P1-6). The replan loop ends two ways — the
    // worklist emptied, or it stopped shrinking — and settling both as a bare finalize would make the second
    // one unsayable. The record has to be able to say "we stopped retrying", because the alternative reading
    // ("there was nothing left to do") is exactly the wrong one.
    abandoned?: number,
  ): Promise<void> {
    const record = await this.getRecord(id);
    const base = record?.scorecard;
    if (!record || !base) return;
    // Settling is a write like any other: it must belong to the pass that owns the marker, or a superseded
    // pass could clear a live one's marker and append its revision on top.
    const pass = await this.owningPass(record, passId);
    this.assertPassSelection(record, pass, judges);
    if (abandoned !== undefined && abandoned > 0)
      await this.deps.store.update(
        id,
        {
          steps: [
            ...(record.steps ?? []),
            {
              ts: this.now(),
              phase: "judges",
              // `info`, not `failed`: the pass DID settle, and every abandoned case keeps reading as unjudged on
              // every measurement surface. The step states the fact; it does not re-judge the pass.
              status: "info",
              message: `${abandoned} case${abandoned === 1 ? "" : "s"} stopped making progress across consecutive planning rounds — the pass stopped re-attempting them and is settling with them unjudged`,
            },
          ],
          updatedAt: this.now(),
        },
        undefined,
        // EVERY write a pass makes is fenced, including the ones that only narrate (arch-review 17 P1-8).
        // This one is an audit note, so the plane is not at risk — but a stale pass waking after a successor
        // took over would append its note to the SUCCESSOR's history, and a system with ownership semantics
        // this strong has no reason to keep an exception for writes that are merely embarrassing rather than
        // corrupting.
        pass.passId !== undefined ? { expectScoringPassId: pass.passId } : undefined,
      );
    await this.aggregate(record, base, base.results, judges, submittedBy, pass);
  }

  // A scoring workflow DIED (arch-review 10 P1). Until this existed, a terminal workflow failure — retries
  // exhausted, the worker terminated, a non-retryable activity error — left the marker saying `running` and
  // the plane blocked for a full lease, indistinguishable from a pass that is simply slow. Then the takeover
  // path had to infer death from a clock, which is exactly the inference the lease replaced the age rule to
  // avoid; here the workflow KNOWS it is dying and says so, so the next pass takes over immediately.
  //
  // The marker flips to `failed` and STAYS: the plane was stripped and partly re-scored, so readers must keep
  // refusing it. Guarded by the pass identity — a workflow that died BECAUSE it was superseded finds the
  // marker already belongs to its successor, and this write correctly misses rather than declaring the live
  // pass dead. Idempotent and best-effort by contract: the caller is a dying workflow's last activity.
  async failScore(id: string, passId: string, reason: string): Promise<{ marked: boolean }> {
    const record = await this.getRecord(id);
    const live = record?.scoringPass ?? undefined;
    if (!record || live === undefined || live.passId !== passId) return { marked: false };
    if (live.status === "failed") return { marked: true }; // already settled as abandoned — a retry of this activity
    const marked = await this.deps.store.update(
      id,
      {
        scoringPass: { ...live, status: "failed", failedAt: this.now(), failure: reason },
        steps: [...(record.steps ?? []), { ts: this.now(), phase: "judges", status: "failed", message: reason }],
        updatedAt: this.now(),
      },
      undefined,
      { expectScoringPassId: passId },
    );
    // A pass declared dead will never write again, so its stage is garbage from this moment on — and unlike
    // the settle path there is no revision to record an observation on, because there is no revision. Nothing
    // is lost by collecting it (the score bytes are shadow; the claims only ever arbitrated between this
    // pass's own invocations). Best-effort, like the notice itself.
    if (marked !== undefined) void this.deps.scoringStage?.clear(id, passId).catch(() => undefined);
    return { marked: marked !== undefined };
  }

  private async track(
    record: ScorecardRecord,
    scorecard: NonNullable<ScorecardRecord["scorecard"]>,
    judges: Array<{ id: string; version: string }>,
    submittedBy: string | undefined,
    pass: ScoringPass,
  ): Promise<void> {
    // The in-process pass judges the WHOLE plane in one applyJudges call, so unlike the Temporal path it has
    // no per-case seam to renew its lease at. A large embed-mode group (or a Temporal-outage fallback) can
    // easily outlive a five-minute lease while working perfectly, and then be taken over — the exact failure
    // the lease replaced the age rule to avoid. A heartbeat keeps the claim alive for as long as this pass is
    // actually running, and stops the moment it is not.
    const heartbeat = setInterval(() => {
      void this.renewLease(record.id, pass).catch(() => undefined);
    }, SCORING_PASS_RENEW_BEFORE_MS);
    // Never hold the process open on this timer alone — a lease renewal is not a reason to stay alive.
    heartbeat.unref?.();
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
      const fresh = await this.deps.store.get(record.id).catch(() => undefined);
      await this.scoring.applyJudges(
        record.tenant,
        dataset,
        results,
        judges,
        record.runtime,
        submittedBy,
        runIdOf,
        (fresh ?? record).scoringPass?.judges,
        undefined,
        // Scope the judge evidence planes to THIS pass (arch-review 41 P0-audit) — and to nothing finer,
        // because there is nothing finer to say. This pass judges the WHOLE plane in ONE applyJudges call
        // with no per-case retry seam (that is the same fact the heartbeat above exists for), so a given
        // (case, judge) is invoked exactly once per pass; a takeover mints a NEW passId and is therefore a
        // new emitter already. It also carries no claim to state — `stageJudgments` gets none below.
        pass.passId,
      );
      await this.writeBackScores(record, results, pass, { judges });
      await this.aggregate(record, scorecard, results, judges, submittedBy, pass);
    } catch (err) {
      // Best-effort visibility: a failed scoring pass never flips the (already settled) group — it leaves a step.
      const fresh = await this.deps.store.get(record.id).catch(() => undefined);
      if (!fresh) return;
      const message = err instanceof Error ? err.message : String(err);
      // The pass marker flips to FAILED and STAYS — the strip already mutated the plane, so readers must
      // keep refusing it (broken evidence is not a readable revision). A later pass takes the marker over.
      const failedPass = fresh.scoringPass ?? undefined;
      // Only MY pass may be marked failed. If a takeover already replaced the marker, flipping it here would
      // declare someone else's live pass dead — the epoch guard makes that write miss instead.
      const mine = failedPass !== undefined && failedPass.passId === pass.passId;
      // A STALE pass writes NOTHING (arch-review 18 P1). The guard was applied only when the marker was still
      // mine, so the one case it was meant to cover — a successor has taken over — fell through to an
      // UNGUARDED write: the dead pass appended "I failed" to the successor's history, and because `steps` is
      // a whole-array read-modify-write it could drop a step the successor wrote in between. The narration is
      // worth having; a stale writer's narration on someone else's record is not.
      if (!mine || pass.passId === undefined) return;
      await this.deps.store
        .update(
          record.id,
          {
            ...(failedPass !== undefined
              ? { scoringPass: { ...failedPass, status: "failed" as const, failedAt: this.now(), failure: message } }
              : {}),
            steps: [...(fresh.steps ?? []), { ts: this.now(), phase: "judges", status: "failed", message }],
            updatedAt: this.now(),
          },
          undefined,
          { expectScoringPassId: pass.passId },
        )
        .catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
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
    pass?: ScoringPass,
  ): Promise<void> {
    const fresh = await this.deps.store.get(record.id);
    if (!fresh) return;
    // THE STAGE IS READ ONCE, HERE — before anything is derived from the plane (arch-review 43 ①). The
    // observation and the promotion are two questions about one read: asking the stage twice could see two
    // different answers (a concurrent clear, a late-landing claim), and the revision would then be certified
    // by a parity report describing a different stage than the one its bytes came from.
    //
    // `results` is the CARRIER plane — what this pass wrote. Parity's whole meaning is stage-vs-that, so it
    // is always computed against it, never against the promoted plane below (which would compare the stage
    // with itself and report perfect agreement for free).
    const observation =
      pass?.passId === undefined ? undefined : await this.stageObservationOf(record.id, pass.passId, results, judges);
    // …and only then, if the read-side switch is on, is the plane this revision certifies rebuilt from the
    // stage. Off (the default) this is the carrier plane unchanged and nothing is recorded.
    const promotion = this.promoteFromStage(results, observation, judges);
    const plane = promotion.results;
    const parity = promotion.parity;
    const summary = summarizeScorecard({ ...base, results: plane });
    // The revision's closure is the PASS-START seal (the marker score()/prepareScore wrote) — the very
    // resolution the pass concretized its judges to, so the ledger records what EXECUTED, not what a
    // finalize-time re-resolution happens to observe after `latest` moved. Sealing live is the fallback
    // for a marker-less legacy pass only.
    const sealed = fresh.scoringPass?.judges ?? (await sealJudgeClosure(this.deps, record.tenant, judges));
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
    // The pass's revision number comes from the MARKER (sealed at pass start — the same number the guarded
    // settle below enforces via the ledger length); a marker-less legacy pass derives it from the ledger.
    const targetRevision = fresh.scoringPass?.targetRevision ?? nextScoringRevision(fresh.scoring);
    const analysis: AnalysisOffload =
      resolution.status === "unresolvable"
        ? {}
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
              plane,
              resolution.policy,
            ),
            pass?.passId ?? fresh.scoringPass?.passId,
          );
    // The stage observation was taken BEFORE anything derived from the plane, so it can ride the REVISION
    // (arch-review 16 P1-6). It used to be a fire-and-forget callback after the settle: a control plane dying
    // in between left the pass with no observation at all, indistinguishable from an agreeing one — and the
    // stage promotion is gated on exactly that evidence. Non-fatal by construction (`stageObservationOf`
    // returns an incomplete observation rather than throwing): a measurement must never be able to fail the
    // thing it measures.
    const scoring = appendScoringRevision(fresh.scoring, {
      kind: "rescore",
      judges: sealed,
      results: plane,
      ...(promotion.promotion !== undefined ? { stagePromotion: promotion.promotion } : {}),
      ...(parity !== undefined
        ? {
            stageParity: {
              // WHICH observer produced this (arch-review 23 P1) — the contract gate counts only its own era.
              version: CURRENT_STAGE_PARITY_VERSION,
              completed: parity.completed,
              ...(parity.failure !== undefined ? { failure: parity.failure } : {}),
              expectedJudged: parity.expectedJudged,
              staged: parity.staged,
              matched: parity.matched,
              missingFromStage: parity.missingFromStage.length,
              mismatched: parity.mismatched.length,
              orphaned: parity.orphaned.length,
              promotionSafe: stagePromotionSafe(parity),
              // …and WHICH units, bounded — the stage rows are dropped a few lines below, so this is the last
              // moment the answer exists at all (arch-review 17 P1-7).
              ...(parity.missingFromStage.length + parity.mismatched.length + parity.orphaned.length > 0
                ? { units: parityUnits(parity) }
                : {}),
            },
          }
        : {}),
      // The revision entry points at its own FROZEN artifact — never the mutable current key a later pass
      // rewrites (I7): historical judgment stays re-derivable, not merely detectable via the plane digest.
      ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
      // …and remembers its durable KEY: the ref expires, and a pass-scoped key is not derivable from the
      // revision number, so without this a historical read has only a dead URL.
      ...(analysis.revisionKey ? { analysisKey: analysis.revisionKey } : {}),
      // WHAT THIS PASS'S JUDGES READ (arch-review 46) — over the plane the revision certifies, checked
      // against the receipt ledger. The write-back already refuses a case whose execution moved under it;
      // this is the durable statement that the refusal had something to refuse ON, and it is what a release
      // gate reads afterwards. An unreadable ledger is recorded as an incomplete observation, never as
      // agreement — the same rule stageParity settled on.
      inputObservation: inputObservationOf(plane, await this.receiptLedgerReading(record.id)),
      ...(pass?.passId !== undefined ? { passId: pass.passId } : {}),
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
      ...(resolution.status === "unresolvable" ? {} : { verdictSummary: verdictSummaryOf(plane, resolution.policy) }),
      ...(judgeModels.length > 0 ? { judgeModels } : {}),
      scoring,
      // A REFUSED promotion is narrated where an operator reads, not only in the ledger (arch-review 43 ①).
      // It rides the settle's own patch, so the statement is as durable as the revision that provoked it —
      // the same reason the parity observation stopped being a callback. `info`, not `failed`: the pass
      // settled correctly on the carriers; what refused is the rehearsal the flag asked for.
      ...(promotion.refusal !== undefined
        ? {
            steps: [
              ...(fresh.steps ?? []),
              {
                ts: this.now(),
                phase: "judges",
                status: "info" as const,
                message: `scoring-stage promotion REFUSED — ${promotion.refusal}`,
              },
            ],
          }
        : {}),
      ...(analysis.ref ? { analysisRef: analysis.ref } : {}),
      ...(fresh.manifest ? { manifest: { ...fresh.manifest, judges: mergedManifestJudges } } : {}),
      ...(fresh.orchestration ? { orchestration: { ...fresh.orchestration, judges: mergedPins } } : {}),
      // Embed-mode groups (no child runs) keep their embed as the score carrier; dedup groups carry runIds
      // and hydrate from the (re-scored) children, so the embed stays out of the row.
      ...(record.runIds?.length ? {} : { scorecard: { ...base, results: plane } }),
    };
    const transition = ScorecardBatch.from(fresh).rescore(
      extras,
      submittedBy !== undefined ? { actor: submittedBy } : {},
      this.now(),
    );
    const stamped = stampFacts(fresh.tenant, transition.facts, { newId: this.newId, now: this.now });
    // Guarded settle (I5): the revision appends ONLY onto the ledger length this pass read. A miss means a
    // concurrent pass settled first (a stale-takeover's original waking late is the real shape) — the late
    // settle REFUSES instead of eating the other pass's revision; its marker stays for the next takeover.
    const settled = await this.deps.store.update(
      record.id,
      transition.patch,
      stamped.map((f) => f.record),
      {
        expectScoringCount: fresh.scoring?.length ?? 0,
        // …and the settle belongs to the pass that OWNS the marker. Guarded by the pass IDENTITY: an epoch
        // restarts at 1 after every settle, so a stale pass could hold a number a later pass also holds —
        // and for an EMBED group there is no child-run fence to catch it, the settle guard is the only one.
        ...(pass?.passId !== undefined ? { expectScoringPassId: pass.passId } : {}),
      },
    );
    if (settled === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: record.id },
        "another scoring pass settled this group first — this pass's aggregate is refused (its revision would have overwritten the ledger).",
      );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    // The same observation as a process METRIC — an operator watching a fleet wants a series, not a walk over
    // revisions. It is now a projection of the durable record rather than the only place the fact exists.
    if (parity !== undefined) this.deps.scoringStageParity?.(parity);
    // …and only NOW is the stage's work finished, so its rows can go (arch-review 16 P1-6). Order matters and
    // is the whole point: the observation is durable first, the evidence is dropped second. Clearing earlier
    // would destroy what the promotion decision reads; never clearing leaves a row per
    // (scorecard × pass × case × judge) forever, on a table whose score bytes nothing reads yet.
    // Best-effort: a settled revision is not undone by a failed cleanup, and the next pass's strip is
    // pass-scoped anyway, so a leftover row is dead weight rather than a hazard.
    // AWAITED, though non-fatal (arch-review 17 P1-7). The ordering — durable observation first, evidence
    // dropped second — is an invariant now, and an unawaited cleanup makes it unobservable: nothing can
    // assert it, and a process exiting right after the settle would leave the rows behind for no reason. The
    // failure is still swallowed: a settled revision is not undone by a cleanup that could not run, and the
    // next pass's strip is pass-scoped anyway, so a leftover row is dead weight rather than a hazard.
    if (pass?.passId !== undefined) await this.deps.scoringStage?.clear(record.id, pass.passId).catch(() => undefined);
  }

  // The receipt ledger, as a READING (arch-review 46) — "there are no receipts" and "the receipts could not
  // be fetched" are opposite facts about a comparison, and an empty array says both. The failure is caught
  // here rather than allowed to fail the settle: this is a measurement of the pass, and a measurement must
  // never be able to fail the thing it measures.
  private async receiptLedgerReading(scorecardId: string): Promise<ReceiptLedgerReading> {
    const store = this.deps.caseReceipts;
    if (!store)
      return {
        kind: "unavailable",
        reason: "no case-commit receipt ledger is wired — nothing vouches for the executions these judges read",
      };
    try {
      return { kind: "read", receipts: await store.list(scorecardId) };
    } catch (err) {
      return {
        kind: "unavailable",
        reason: `the case-commit receipt ledger could not be read (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  // Compare what THIS pass staged against the plane it settled — and, first, against what it actually JUDGED.
  //
  // `expected` is derived from the SETTLED PLANE, never from the stage (arch-review 11). A pass strips the
  // selected judges' rows before it starts, so any selected-judge row on the settled plane was produced by
  // this pass: that set IS "what this pass judged", independently of whether the stage write survived. A
  // comparison that walked the staged rows alone could only ever report on the writes that succeeded, which
  // is precisely the failure mode a best-effort write has. Non-gradeable cases are excluded — the strip skips
  // them, so their surviving old rows are inherited, not produced.
  private async stageObservationOf(
    scorecardId: string,
    passId: string,
    settled: CaseResult[],
    judges: ReadonlyArray<{ id: string }>,
  ): Promise<StageObservation | undefined> {
    const stage = this.deps.scoringStage;
    // No stage wired = nothing to observe. The revision carries no `stageParity`, which reads as "unobserved"
    // — never as "agreed".
    if (!stage) return undefined;
    try {
      // Compared per (case, JUDGE), matching the stage's key (mig 0153). Per case, a pass that staged one of
      // two judges on a case counted as "staged" and the missing judge was invisible — the same
      // measure-only-what-you-wrote blindness the expected/missing split exists to remove, one unit down.
      // A canonical tuple — never a delimiter join over strings a caller controls (arch-review 15 §14).
      // `judgeId` is a free-form string, so "a b"+"c" and "a"+"b c" collided; the stage store already fixed
      // the same habit, and parity is the certification input for the stage promotion, not mere telemetry.
      const unit = (caseKey: string, judgeId: string) => JSON.stringify([caseKey, judgeId]);
      const produced = new Map<string, CaseResult["scores"]>();
      for (const r of settled) {
        if (!judgeGradeable(r)) continue;
        const caseKey = childKey(r.caseId, r.trial);
        for (const j of judges) {
          const delta = r.scores.filter((s) => isJudgeMetricOf(s.metric, j.id));
          if (delta.length > 0) produced.set(unit(caseKey, j.id), delta);
        }
      }
      const staged = await stage.staged(scorecardId, passId);
      // A ZERO-WORK pass still reports (arch-review 14 §12). Returning early re-created the very ambiguity
      // `completed` was added to remove: a legitimate no-op, a failed measurement and "no report at all"
      // became indistinguishable in a denominator of settled passes. It emits `completed: true` with zeros —
      // which is a measurement, and a passing one.
      const stagedKeys = new Set(staged.map((e) => unit(e.caseKey, e.judgeId)));
      const missingFromStage = [...produced.keys()].filter((k) => !stagedKeys.has(k));
      const mismatched: string[] = [];
      const orphaned: string[] = [];
      let matched = 0;
      for (const entry of staged) {
        const key = unit(entry.caseKey, entry.judgeId);
        const live = produced.get(key);
        if (live === undefined) {
          orphaned.push(key);
          continue;
        }
        // Equality over the delta rows, CANONICALLY (arch-review 16 P1-6). `JSON.stringify` compared two
        // objects that had travelled different storage paths: the plane's rows come back through
        // `ScoreSchema.parse` (declaration key order, defaults such as `status: "measured"` applied), the
        // staged rows come back as raw jsonb (Postgres key order, no defaults). Byte-identical judgments
        // therefore compared UNEQUAL — so the parity series that gates the stage promotion was reporting a
        // mismatch for essentially every pass, which is worse than no measurement: it is a measurement that
        // is always wrong in the direction of "do not promote", so nobody would ever look for the cause.
        //
        // Both sides are normalized through the same schema and digested canonically (sorted keys), and the
        // family is sorted by metric so a verdict/criterion ordering difference is not a content difference.
        if (canonicalScores(live) === canonicalScores(entry.scores)) matched += 1;
        else mismatched.push(key);
      }
      return {
        parity: {
          scorecardId,
          passId,
          completed: true,
          expectedJudged: produced.size,
          staged: staged.length,
          missingFromStage,
          matched,
          mismatched,
          orphaned,
          // …AND WHICH PLANE IT WAS ALL COMPARED TO (arch-review 44 ②). `settled` is the CARRIER plane, and
          // that has to stay true through the contract step, when the plane a settle certifies starts coming
          // from the stage. Pinning the basis here means the promotion can check the claim instead of the
          // next reader having to preserve a statement order.
          basisDigest: scorePlaneDigest(settled),
        },
        // The rows the promotion merges, from THIS read — never a second one (see the call site).
        staged,
      };
    } catch (err) {
      // A parity report that cannot run tells us nothing — and SAYING that is the point (arch-review 13 P1).
      // Reporting nothing made "every pass agreed" and "no pass was ever checked" the same picture, and the
      // contract step reads that picture. It still must not turn a settled pass into a failed one.
      return {
        parity: {
          scorecardId,
          passId,
          completed: false,
          failure: err instanceof Error ? err.message : String(err),
          expectedJudged: 0,
          staged: 0,
          missingFromStage: [],
          matched: 0,
          mismatched: [],
          orphaned: [],
        },
        // An unread stage has no rows to promote — and an incomplete observation refuses the promotion
        // outright, so this empty list is never the thing a plane gets built from.
        staged: [],
      };
    }
  }

  // THE READ-SIDE SWITCH (arch-review 43 ①) — where a settled pass decides whether the plane it certifies is
  // the one it wrote to the carriers, or the one its own stage says it produced.
  //
  // This is the contract step's merge, deployed as a REHEARSAL. Two properties make it worth running before
  // the migration rather than as the migration:
  //
  //   1. It exercises the PROMOTION CODE on real traffic. Every piece of evidence gathered so far compares
  //      DATA — staged bytes against plane bytes — which certifies the dual write and says nothing about the
  //      merge that would consume it. The merge is where the interesting mistakes live (inherited rows
  //      dropped, an unselected judge's family replaced), and until now it did not exist to be wrong.
  //   2. It cannot change a record. The promotion is applied only when this pass's own parity observation
  //      says the two sources agree completely, and the promoted plane is then re-digested against the
  //      carrier plane before it is used. A promotion that would alter the bytes is REFUSED and the refusal
  //      is recorded — the two sources never silently disagree, which is the whole invariant.
  //
  // The refusal path is not a fallback with a log line: `stagePromotion.applied: false` plus a reason lands
  // on the revision and a step lands on the record, so "the switch was on and it declined" is a fact a later
  // reader can find. Off (the default) this returns the carrier plane and records nothing at all.
  private promoteFromStage(
    carrier: CaseResult[],
    observation: StageObservation | undefined,
    judges: ReadonlyArray<{ id: string }>,
  ): {
    results: CaseResult[];
    parity?: ScoringStageParity;
    promotion?: { applied: boolean; refusal?: string };
    refusal?: string;
  } {
    if (this.deps.scoringStageAuthoritative !== true)
      return { results: carrier, ...(observation !== undefined ? { parity: observation.parity } : {}) };
    if (observation === undefined) {
      // The flag is on and there is nothing to promote FROM. Recorded rather than ignored: a pass that ran
      // with no stage under a deployment that believes it is promoting is precisely the configuration whose
      // silence would later be read as evidence.
      const refusal =
        "this pass has no stage observation (no scoring stage is wired, or the pass carries no identity) — the carriers stay authoritative";
      return { results: carrier, promotion: { applied: false, refusal }, refusal };
    }
    // …and the observation must be about THIS plane (arch-review 44 ②). The comparison's basis is checked,
    // not assumed: the contract step makes the settled plane come from the stage, and a comparison re-based
    // onto that plane agrees with itself perfectly on every pass. Stating the basis and checking it is what
    // keeps the step from being takeable by moving one statement.
    const unsafe = stagePromotionRefusal(observation.parity, scorePlaneDigest(carrier));
    if (unsafe !== undefined)
      return {
        results: carrier,
        parity: observation.parity,
        promotion: { applied: false, refusal: unsafe },
        refusal: unsafe,
      };
    const promoted = promoteStagedJudgments(carrier, observation.staged, judges);
    if (scorePlaneDigest(promoted) !== scorePlaneDigest(carrier)) {
      // The comparison said the two sources are identical and the merge produced a different plane. One of
      // them is wrong, and nothing here can say which — so the OBSERVATION is voided too, not merely the
      // promotion. Recording it as `completed: false` is what keeps the fleet gate honest: a green
      // `promotionSafe` beside a refused promotion would let the contract step be certified by the very
      // report its rehearsal just contradicted.
      const diverged =
        "the plane promoted from the stage differs from the plane this pass wrote, on units the parity comparison called identical — the comparison and the merge disagree, so neither may certify this revision";
      return {
        results: carrier,
        parity: { ...observation.parity, completed: false, failure: diverged },
        promotion: { applied: false, refusal: diverged },
        refusal: diverged,
      };
    }
    return { results: promoted, parity: observation.parity, promotion: { applied: true } };
  }

  // The dataset judges align against: the registered one when it resolves; otherwise (ad-hoc experiments under
  // the _adhoc sentinel, trace-eval groups, a deleted dataset) synthesize prompt-shell cases from the results —
  // the same shape the ingest path scores dataset-less traces with.
  private async effectiveDataset(record: ScorecardRecord, results: CaseResult[]): Promise<Dataset> {
    try {
      const resolved = await this.deps.datasets.get(record.tenant, record.dataset.id, record.dataset.version);
      // THE JUDGE'S CONTEXT MUST BE THE ONE THIS BATCH SEALED (arch-review 17 P0-1). A re-score re-reads the
      // dataset by (tenant, id, version), and lookup is owner-first over a `_shared` fallback — so a
      // workspace-local version registered since submit shadows the document the manifest certified, and the
      // judge would re-judge a stored trace against a task, expectation or milestone the run never saw. That
      // is a wrong VERDICT over right evidence, which is the worst shape this system can produce.
      //
      // The judged cases must each still EXIST in the current resolution, not merely match where they do
      // (arch-review 18 P0-3). The first version filtered the resolved dataset down to the judged ids, so a
      // case the shadow DELETED simply never appeared: verification passed, the shadowed dataset was
      // returned, and the judge stream then skipped that case for having no `EvalCase` — after the pass had
      // already stripped its judge rows. The case ended the pass with its verdict removed and nothing written
      // in its place, produced by a check that was looking straight at it.
      // …asked of the PLAN, like every other execution path (arch-review 22 P1). Re-score is a different
      // question — the current dataset may legitimately be larger — but not a different artifact, and a
      // second direct reader of the manifest is exactly what the plan exists to end.
      const judged = [...new Set(results.map((r) => r.caseId))];
      ExecutionPlan.of(record).assertJudgedCases(judged, resolved.cases);
      return resolved;
    } catch (err) {
      // A refusal is a decision, not a lookup failure — it must not fall through to the shell dataset, which
      // would judge against empty tasks and call that a verdict.
      if (err instanceof ConflictError) throw err;
      // …AND NEITHER MAY A LOOKUP FAILURE, when this batch certified real case documents (arch-review 19 P0-2).
      //
      // The shell dataset synthesizes `task: ""`, no expected answer and no milestones. That is the honest
      // shape for a record that never had a registry dataset — an ad-hoc experiment, a directly-evaluated
      // trace. Applying it to a batch whose manifest SEALED case documents turns a registry outage or a
      // deleted dataset into the most dangerous thing this system can produce: the trace and snapshot are
      // the real execution's evidence, so a judge re-reads genuine evidence against a question that has been
      // emptied out, and returns a measured verdict for it. Right evidence, wrong question, real score —
      // and nothing downstream looks anomalous.
      //
      // A fallback is a new semantic decision; it may not silently replace an identity the system knew
      // exactly. Losing the historical context is a reason to refuse, not a reason to continue with less.
      const datasetless = record.dataset.id === EXPERIMENT_ADHOC_REF || record.dataset.id === TRACE_EVAL_REF;
      if (!datasetless && ExecutionPlan.of(record).sealsCaseDocuments)
        throw new ConflictError(
          "CONFLICT",
          { scorecard: record.id, dataset: `${record.dataset.id}@${record.dataset.version}` },
          `this batch sealed the case documents it evaluated and they can no longer be read (${
            err instanceof Error ? err.message : String(err)
          }) — refusing to re-judge its evidence against an empty task, which would produce a real verdict for a question this batch never asked.`,
        );
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
    if (!this.deps.runStore || !record.runIds?.length) return undefined;
    try {
      const { byKey } = await this.scoreCarriersByKey(record);
      return (caseId, trial) => byKey.get(childKey(caseId, trial))?.id;
    } catch {
      // Best-effort by contract, including an unreadable receipt ledger: the judges still run and meter, and
      // no evidence plane lands. What must never happen is guessing a carrier — a plane sealed on the wrong
      // attempt is worse than no plane, which is why this degrades to undefined rather than to last-wins.
      return undefined;
    }
  }

  // ── WHICH CHILD CARRIES THIS CASE'S SCORES (arch-review 43, Phase 3) ────────────────────────────────
  //
  // One map, built once, for BOTH the judge's evidence-plane seal and the carrier write-back. The two used
  // to build it separately and identically, which is exactly how a selector defect survives being fixed in
  // one of them — the same "reviewing them separately is what made the recurrence structural" this file
  // records for the two case-finalize paths.
  //
  // The receipt names the attempt that ANSWERED the case; folding `children.filter(result)` into a Map names
  // whichever attempt the run store happened to list LAST. On a resumed or retried batch those are different
  // rows, so a re-score wrote its verdicts onto a superseded attempt while `get` served the committed one —
  // a pass that costs provider calls and then looks like it did nothing, because the plane a reader sees
  // never moved. Per-case fallback, on the same terms as the hydration: a case with no receipt (a batch
  // predating the ledger) keeps the last-wins row, which is what those rows can support.
  //
  // The ledger read is NOT caught here. An unreadable ledger cannot answer which attempt is canonical, and a
  // write that proceeds anyway lands bytes on a row nobody vouched for; the caller decides what that means
  // (the resolver degrades to no plane, the write-back fails the pass and is retried).
  //
  // …and it hands the RECEIPTS back with the rows (arch-review 46). The read already happens here, and every
  // caller that resolves a carrier also needs to know what the ledger vouches for it — dropping the receipts
  // meant a second reader had to fetch them again, which is a second read of a moving ledger and therefore a
  // second answer.
  private async scoreCarriersByKey(
    record: ScorecardRecord,
  ): Promise<{ byKey: Map<string, RunRecord>; receiptByKey: Map<string, CaseCommitReceipt> }> {
    const store = this.deps.runStore;
    if (!store) return { byKey: new Map(), receiptByKey: new Map() };
    const children = await store.list(record.tenant, { scorecardId: record.id });
    // Only children WITH a result can carry scores — and a result-less child must not enter the map:
    // childKey(trial: undefined) collapses onto "#0", where the last result-less child would silently SHADOW
    // the real trial-0 child and make the write-back skip it.
    const byKey = new Map(
      children.filter((c) => c.result).map((c) => [childKey(c.caseId, c.result?.trial), c] as const),
    );
    const committed = (await this.deps.caseReceipts?.list(record.id)) ?? [];
    for (const [key, child] of ScorecardBatch.canonicalChildPerCase(children, committed))
      if (child.result) byKey.set(key, child);
    return { byKey, receiptByKey: new Map(committed.map((r) => [childKey(r.caseId, r.trial), r] as const)) };
  }

  // STAGE this pass's judgments (expand step, scoring-plane-revisions.md) and return the arbitration the
  // carrier write then obeys. Its own method, and called BEFORE the carrier guard, because a group that has
  // no per-case carrier still has judgments to record (arch-review 44 ①).
  //
  // Written and never decided on: the carriers stay the source of truth for this deploy, so a rollback loses
  // nothing, and the contract step later makes the finalize promote from here instead of writing through.
  //
  // A TRUE DELTA: only the SELECTED judges' rows (arch-review 11). The port called this a delta and the
  // code staged the whole resulting case plane — inherited graders and other judges included. Two costs:
  // the promotion could not tell what this pass PRODUCED from what it merely carried along, and a stage
  // that contains the inherited plane silently becomes a full-plane snapshot whose correctness depends on
  // the pass having read the inherited rows at exactly the right moment. Staging the delta makes the
  // promotion's merge explicit — inherited evidence stays on the carrier, produced evidence comes from here.
  // `stage: false` from the strip — a staged row is a JUDGMENT, never merely a touch.
  //
  // …one row per (case, JUDGE) — the unit everything else about a judgment already uses (mig 0153) — and the
  // stage CLAIMS them (mig 0158, arch-review 14 §11). The claim is the arbitration between two attempts of
  // the SAME pass, which the pass fence structurally cannot perform: Temporal retries an activity inside one
  // pass, so a timed-out attempt whose provider call is still running and its replacement both hold the same
  // passId and both clear every guard.
  //
  // The CURRENT attempt wins, and a superseded one writes NOTHING further — including to the carrier. That
  // last part is the point: the stage said "first wins" while the carrier said "last wins", so the two
  // disagreed by construction and the revision took the carrier's answer while parity noticed afterwards.
  // A report is not an arbitration. One decider, and the other follows it.
  //
  // Returns WHAT THIS ATTEMPT IS ALLOWED TO WRITE, per (case, JUDGE) — undefined maps mean no arbiter is
  // wired, and the carrier write proceeds as it did before the stage existed.
  private async stageJudgments(
    record: ScorecardRecord,
    results: CaseResult[],
    pass: ScoringPass | undefined,
    opts: { stage?: boolean; judges?: ReadonlyArray<{ id: string }>; claim?: JudgmentClaim },
  ): Promise<{ acceptedByCase?: Map<string, Set<string>>; claimedCases?: Set<string> }> {
    const stage = this.deps.scoringStage;
    if (opts.stage === false || !stage || pass?.passId === undefined || !opts.judges) return {};
    const selected = opts.judges;
    const entries: StagedJudgment[] = results.flatMap((r) => {
      const caseKey = childKey(r.caseId, r.trial);
      return selected.flatMap((j) => {
        const scores = r.scores.filter((s) => isJudgeMetricOf(s.metric, j.id));
        // A judge with no rows on this case produced nothing here — staging an empty row would assert a
        // judgment that does not exist, and the parity report would then count it as one.
        return scores.length > 0
          ? [{ caseKey, judgeId: j.id, scores, ...(opts.claim !== undefined ? { claim: opts.claim } : {}) }]
          : [];
      });
    });
    if (entries.length === 0) return {};
    // FAIL-CLOSED (arch-review 15 P0-3). While the stage was shadow telemetry, swallowing its failure and
    // writing anyway was the rollback-safe choice. It stopped being shadow the moment it became the ARBITER:
    // an arbiter that cannot answer must not be read as "you won", or the very race it exists to settle is
    // restored at exactly the moment it is least observable. The activity fails, Temporal retries, and the
    // carrier is untouched — which now also means an embed group's settle fails rather than settling over a
    // plane the arbiter never saw.
    //
    // Note the split this makes explicit: the stage's DATA authority is still shadow (the carriers remain the
    // source of truth until the contract step), while its WRITE-CLAIM authority is already
    // production-critical. Two different questions about one table.
    const accepted = await stage.stage(record.id, pass.passId, entries);
    const acceptedByCase = new Map<string, Set<string>>();
    for (const e of accepted) {
      const set = acceptedByCase.get(e.caseKey) ?? new Set<string>();
      set.add(e.judgeId);
      acceptedByCase.set(e.caseKey, set);
    }
    return { acceptedByCase, claimedCases: new Set(entries.map((e) => e.caseKey)) };
  }

  // Every child write is FENCED by the owning pass (arch-review 8 P0): the store commits only while that
  // pass still owns the parent's marker, evaluated in the same statement as the write. Checking ownership
  // here instead would leave the window it exists to close — the winner settles between the check and the
  // write, and the late write then lands on a SETTLED plane where the marker (the read guard) is already
  // gone, so the plane silently stops matching the revision digest that certifies it.
  private async writeBackScores(
    record: ScorecardRecord,
    results: CaseResult[],
    pass?: ScoringPass,
    // `judges` is what makes the stage a DELTA — without it there is nothing to select, so the write is
    // skipped rather than degrading into a full-plane snapshot the promotion would misread.
    // `claim` is the (generation, attempt) ordinal this write belongs to — the token that tells two
    // invocations of ONE pass apart (mig 0158/0159). Absent = the in-process pass, which has neither
    // rotations nor retries to distinguish.
    opts: { stage?: boolean; judges?: ReadonlyArray<{ id: string }>; claim?: JudgmentClaim } = {},
  ): Promise<void> {
    // THE STAGE WRITE COMES FIRST, AND IT IS NOT THE CARRIER'S TO SKIP (arch-review 44 ①). It used to sit
    // below the guard on the next line, so a group with no child runs — an EMBED group, whose carrier is the
    // embedded scorecard rather than a per-case row — was judged, carried, and never staged. Parity reported
    // that correctly (`missingFromStage` = everything), and the correctness was the trap: the fleet readiness
    // gate could never go green while embed groups ran, and a contract step taken anyway would have dropped
    // every embed group's judgments. Two different questions shared one guard, and the carrier's answer
    // decided the judgment's.
    const arbitration = await this.stageJudgments(record, results, pass, opts);
    const store = this.deps.runStore;
    // The CARRIER write keeps its own guard: an embed group writes its plane through the settle's embedded
    // `scorecard` patch, not per case, so there is nothing for this loop to do.
    if (!store || !record.runIds?.length) return;
    const { acceptedByCase, claimedCases } = arbitration;
    const fence = pass?.passId !== undefined ? { scorecardId: record.id, passId: pass.passId } : undefined;
    // The receipt-canonical carrier per case (see scoreCarriersByKey) — a re-score's verdicts belong on the
    // attempt that answered the case, which is the row every reader hydrates from.
    const { byKey, receiptByKey } = await this.scoreCarriersByKey(record);
    for (const r of results) {
      const child = byKey.get(childKey(r.caseId, r.trial));
      if (!child?.result) continue;
      const caseKey = childKey(r.caseId, r.trial);
      // WHAT THE JUDGE READ MUST STILL BE WHAT THE LEDGER VOUCHES FOR (arch-review 46).
      //
      // The pass hydrated this case's result once, judged that copy, and is now writing verdicts back onto
      // the carrier. Between those two moments the case can legitimately be RE-DRIVEN — a recovery, a
      // re-attempt — which commits a new receipt naming a different child and a different execution. Every
      // guard in this file would still pass: the pass owns the marker, the fence holds, the write lands. What
      // it would land is one execution's verdicts on another execution's row, and afterwards nothing in the
      // record can tell: the scores are well-formed, the digests all agree with themselves.
      //
      // So the receipt's own execution digest is checked against the bytes this pass judged, and a mismatch
      // REFUSES — the same posture as the superseded-write refusal below, for the same reason: a judgment
      // derived from bytes nobody vouches for is not evidence. On Temporal the activity retries against the
      // new canonical child; the in-process pass flips its marker failed and a takeover re-scores. A legacy
      // receipt (no observation half) has nothing to compare and is not treated as agreement — it simply
      // cannot answer, which is what those rows can support.
      const receipt = receiptByKey.get(caseKey);
      if (receipt?.observationDigest !== undefined && caseObservationDigest(r) !== receipt.observationDigest)
        throw new ConflictError(
          "CONFLICT",
          { scorecard: record.id, case: caseKey, passId: pass?.passId, childRunId: receipt.childRunId },
          "this case's execution was re-committed while the pass was judging it — the verdicts describe bytes the ledger no longer vouches for, so the write-back is refused.",
        );
      // MERGE PER JUDGE — never per case (arch-review 15 P0-1). The stage arbitrates at (case, judge) and
      // the first version collapsed its answer back to a case-level boolean: one accepted judge let the
      // WHOLE case plane through, so a REJECTED judge's bytes rode along on its neighbour's win. Deciding in
      // one unit and mutating in another is the exact shape this codebase keeps removing, reintroduced by
      // the fix for it.
      //
      // So the write strips and replaces ONLY the accepted families, onto the child's CURRENT scores — which
      // is what the winning attempt left there. A judge this attempt lost keeps the winner's row untouched.
      let nextScores = r.scores;
      if (acceptedByCase !== undefined && claimedCases?.has(caseKey)) {
        const won = acceptedByCase.get(caseKey);
        if (won === undefined || won.size === 0) continue; // every judge here was superseded — write nothing
        const winners = [...won].map((id) => ({ id }));
        const mine = r.scores.filter((s) => winners.some((j) => isJudgeMetricOf(s.metric, j.id)));
        nextScores = [...stripJudgeScores(child.result.scores, winners), ...mine];
      }
      const written = await store.update(
        child.id,
        { result: { ...child.result, scores: nextScores }, updatedAt: this.now() },
        undefined,
        fence ? { scoring: fence } : undefined,
      );
      // A fenced miss means this pass was superseded MID-WRITE. Stop immediately: continuing would scatter
      // half of a dead pass's judgments across a plane another pass is certifying.
      if (written === undefined && fence !== undefined)
        throw new ConflictError(
          "CONFLICT",
          { scorecard: record.id, passId: fence.passId },
          "this scoring pass was superseded while writing back scores — its remaining writes are refused.",
        );
    }
  }
}
