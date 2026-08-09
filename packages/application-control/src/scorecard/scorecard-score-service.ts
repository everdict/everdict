import {
  BadRequestError,
  type CaseResult,
  ConflictError,
  type Dataset,
  type EvalCase,
  NotFoundError,
  SCORING_PASS_LEASE_MS,
  SCORING_PASS_RENEW_BEFORE_MS,
  type ScorecardRecord,
  type ScoringPass,
  scoringPassReclaimable,
} from "@everdict/contracts";
import {
  ScorecardBatch,
  type ScorecardOutcomeExtras,
  judgeGradeable,
  nextScoringRevision,
  summarizeScorecard,
  verdictSummaryOf,
} from "@everdict/domain";
import { appendScoringRevision, resolvePolicyResolution } from "@everdict/domain";
import { childKey, hasMeasuredJudgeVerdict, stripJudgeScores } from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { ScorecardScoringDeps } from "./scorecard-deps.js";
import { type AnalysisOffload, analysisBundle, offloadAnalysis } from "./scorecard-observability.js";
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
      Date.parse(pass.leaseUntil) - Date.parse(this.now()) > SCORING_PASS_RENEW_BEFORE_MS
    )
      return true;
    // The CAS is the authority — no pre-read to disagree with it. A miss means the epoch moved, i.e. this
    // pass was taken over, which is exactly what the caller needs to know.
    const renewed = await this.deps.store.update(
      id,
      { scoringPass: { ...pass, leaseUntil: this.leaseUntil(), heartbeatAt: this.now() }, updatedAt: this.now() },
      undefined,
      // The STORE stamps the lease's end from the clock that will later judge it expired (arch-review 10 P1).
      // The `leaseUntil` above is the fallback a store without the capability keeps using; where the
      // capability exists it is overwritten, and a fast replica can no longer mint a lease the database
      // considers already dead.
      { expectScoringPassId: pass.passId ?? null, stampScoringLeaseSeconds: SCORING_PASS_LEASE_MS / 1000 },
    );
    return renewed !== undefined;
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
    await this.owningPass(record, passId);
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
    passId?: string,
  ): Promise<{ scored: boolean; skipped?: boolean }> {
    const record = await this.getRecord(id);
    if (!record) throw new NotFoundError("NOT_FOUND", { scorecard: id }, "Scorecard not found.");
    // Ownership first: a judgment produced by a superseded pass is work nobody asked for, and writing it
    // back would corrupt the live pass's plane. Renewing here is also what keeps a long, healthy pass alive
    // — the lease advances per case, so "still working" and "still owner" are the same statement.
    const pass = await this.owningPass(record, passId);
    if (!(await this.renewLease(id, pass)))
      throw new ConflictError(
        "CONFLICT",
        { scorecard: id, passId: pass.passId },
        "this scoring pass lost its lease — a newer pass owns the group's score plane.",
      );
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
    // The pass marker's sealed closure is the concretization source — every scoreCase activity of one pass
    // judges under the SAME resolution, even when `latest` moves between activities (I6).
    await this.scoring.applyJudges(
      record.tenant,
      dataset,
      [single],
      judges,
      record.runtime,
      submittedBy,
      runIdOf,
      pass.judges,
    );
    await this.writeBackScores(record, [single], pass);
    return { scored: true };
  }

  // Re-aggregate from the (now re-scored) children and settle through the rescore transition — the terminal
  // step of the workflow pass. Reloads hydrated state, so it sees exactly what the scoreCase activities wrote.
  async finalizeScore(
    id: string,
    judges: Array<{ id: string; version: string }>,
    submittedBy?: string,
    passId?: string,
  ): Promise<void> {
    const record = await this.getRecord(id);
    const base = record?.scorecard;
    if (!record || !base) return;
    // Settling is a write like any other: it must belong to the pass that owns the marker, or a superseded
    // pass could clear a live one's marker and append its revision on top.
    const pass = await this.owningPass(record, passId);
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
      );
      await this.writeBackScores(record, results, pass);
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
      await this.deps.store
        .update(
          record.id,
          {
            ...(mine && failedPass !== undefined
              ? { scoringPass: { ...failedPass, status: "failed" as const, failedAt: this.now(), failure: message } }
              : {}),
            steps: [...(fresh.steps ?? []), { ts: this.now(), phase: "judges", status: "failed", message }],
            updatedAt: this.now(),
          },
          undefined,
          mine && pass.passId !== undefined ? { expectScoringPassId: pass.passId } : undefined,
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
    const summary = summarizeScorecard({ ...base, results });
    const fresh = await this.deps.store.get(record.id);
    if (!fresh) return;
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
              results,
              resolution.policy,
            ),
            pass?.passId ?? fresh.scoringPass?.passId,
          );
    const scoring = appendScoringRevision(fresh.scoring, {
      kind: "rescore",
      judges: sealed,
      results,
      // The revision entry points at its own FROZEN artifact — never the mutable current key a later pass
      // rewrites (I7): historical judgment stays re-derivable, not merely detectable via the plane digest.
      ...(analysis.revisionRef ? { analysisRef: analysis.revisionRef } : {}),
      // …and remembers its durable KEY: the ref expires, and a pass-scoped key is not derivable from the
      // revision number, so without this a historical read has only a dead URL.
      ...(analysis.revisionKey ? { analysisKey: analysis.revisionKey } : {}),
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
      ...(analysis.ref ? { analysisRef: analysis.ref } : {}),
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
    // …and REPORT how the stage compared to the plane this pass just certified (arch-review 10 P1). The
    // contract step promotes from the stage instead of the carriers, and the basis for that swap is having
    // watched the two agree on real traffic — dual-writing without ever comparing proves only that both
    // writes happened. Strictly after the settle and strictly non-fatal: a measurement must never be able to
    // fail the thing it measures.
    if (pass?.passId !== undefined) void this.reportStageParity(record.id, pass.passId, results);
  }

  // Compare what THIS pass staged against the plane it settled. Judgment-delta semantics (see the port), so
  // the comparison is over the staged cases only: a case this pass never judged has no staged row and is
  // nothing to disagree about. `orphaned` is the shape that would make a promotion INVENT a row, which is
  // why it is counted separately from a plain value mismatch.
  private async reportStageParity(scorecardId: string, passId: string, settled: CaseResult[]): Promise<void> {
    const report = this.deps.scoringStageParity;
    const stage = this.deps.scoringStage;
    if (!report || !stage) return;
    try {
      const staged = await stage.staged(scorecardId, passId);
      if (staged.length === 0) return; // an embed group / a pass with no staged judgments — nothing to compare
      const plane = new Map(settled.map((r) => [childKey(r.caseId, r.trial), r.scores] as const));
      const mismatched: string[] = [];
      const orphaned: string[] = [];
      let matched = 0;
      for (const entry of staged) {
        const live = plane.get(entry.caseKey);
        if (live === undefined) {
          orphaned.push(entry.caseKey);
          continue;
        }
        // Structural equality over the score rows — the promotion would write these bytes verbatim, so the
        // comparison is the same one the promotion's correctness rests on.
        if (JSON.stringify(live) === JSON.stringify(entry.scores)) matched += 1;
        else mismatched.push(entry.caseKey);
      }
      report({ scorecardId, passId, staged: staged.length, matched, mismatched, orphaned });
    } catch {
      // A parity report that cannot run tells us nothing; it must not turn a settled pass into a failed one.
    }
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

  // Every child write is FENCED by the owning pass (arch-review 8 P0): the store commits only while that
  // pass still owns the parent's marker, evaluated in the same statement as the write. Checking ownership
  // here instead would leave the window it exists to close — the winner settles between the check and the
  // write, and the late write then lands on a SETTLED plane where the marker (the read guard) is already
  // gone, so the plane silently stops matching the revision digest that certifies it.
  private async writeBackScores(
    record: ScorecardRecord,
    results: CaseResult[],
    pass?: ScoringPass,
    opts: { stage?: boolean } = {},
  ): Promise<void> {
    const store = this.deps.runStore;
    if (!store || !record.runIds?.length) return;
    const fence = pass?.passId !== undefined ? { scorecardId: record.id, passId: pass.passId } : undefined;
    // …and STAGE the same judgments under this pass (expand step, scoring-plane-revisions.md). Written and
    // never decided on: the carriers below stay the source of truth for this deploy, so a rollback loses
    // nothing, and the contract step later makes the finalize promote from here instead of writing through.
    // A staging failure must not fail a pass that is writing its plane correctly — nothing depends on it yet.
    // `stage: false` from the strip — a staged row is a JUDGMENT, never merely a touch (see the port).
    if (opts.stage !== false && this.deps.scoringStage && pass?.passId !== undefined) {
      await this.deps.scoringStage
        .stage(
          record.id,
          pass.passId,
          results.map((r) => ({ caseKey: childKey(r.caseId, r.trial), scores: r.scores })),
        )
        .catch(() => undefined);
    }
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
      const written = await store.update(
        child.id,
        { result: { ...child.result, scores: r.scores }, updatedAt: this.now() },
        undefined,
        fence,
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
