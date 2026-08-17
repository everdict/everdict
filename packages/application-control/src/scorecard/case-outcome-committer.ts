import {
  type CaseCommitReceipt,
  type CaseResult,
  type DomainFact,
  type ExecutionAttemptState,
  InternalError,
  type PersistedWorkIntent,
  type RunRecord,
  type RuntimeWorkRef,
  type VerdictPolicy,
  attemptIdOf,
} from "@everdict/contracts";
import {
  Run,
  caseObservationDigest,
  caseReason,
  caseResultDigest,
  caseVerdict,
  childKey,
  completeJudgeCoverage,
  contentDigest,
} from "@everdict/domain";
import type { SealedJudgeClosure } from "../execution/scoring-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import { offloadSnapshot } from "../ports/artifact-store.js";
import type { OutboxEvent, RunStore } from "../ports/run-store.js";
import { settleRun } from "../ports/settle.js";
import { dispatchManifest, foldEnvDeltas } from "../recording-manifest.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";

// ── WHERE A CASE ENDS (arch-review 47 §4) ────────────────────────────────────────────────────────────
//
// The commit point extracted out of ScorecardBatchService, unchanged: judge coverage, the evidence
// assembly, the receipt, the child row's one terminal write and the attempt's terminal stamp. Both batch
// drivers reach it through the facade, which is what "one finalizer, both drivers" (review 39, Phase 2)
// has meant since it was written — this file is that sentence made structural, so the next reader looking
// for "what ending a case means" finds one file rather than a cluster inside a 3400-line orchestrator.
//
// It holds NO per-batch state on purpose (arch-review 34 P0): the pending/failure maps a track loop keeps
// are the BATCH's, so they are passed in as arguments and never lifted to a field here — one service
// instance drives every batch in the process, and a field would be the cross-batch collision that lesson
// is named after.

// The slice of the batch bag a commit actually touches: the two ledgers it writes, the evidence stores the
// assembly stages into, and the bus the completion fact nudges. Nothing here can dispatch or kill.
type CaseOutcomeCommitterDeps = Pick<
  ScorecardBatchDeps,
  "runStore" | "caseReceipts" | "attempts" | "artifacts" | "recordingStore" | "events"
>;

// A case whose execution is done and whose child row is deliberately still open until its judges land.
export interface PendingChildSettle {
  childId?: string;
  ranOn?: string;
  parentDriver: { scorecardId: string; epoch: number };
  // The id this case was dispatched with — the key its replay buffer is written under (mig 0172) — and the
  // ATTEMPT under that id (mig 0173), which every append and the seal must carry.
  executionId: string;
  // Absent when the attempt never opened one (recording claim refused) — never 0: that sentinel fabricated
  // a `<executionId>#g0` coordinate no ledger mints, and every unisolated case collided on it (review 46).
  generation?: number;
  // …and the attempt's LEDGER ROW by name (arch-review 51). The generation above is the RECORDING fence, and
  // it is absent exactly when the claim was refused — while the row exists all the same. Deriving the name
  // from the generation therefore left every UNISOLATED attempt unaddressable: opened, run, and never
  // terminalized. Optional because callers that predate the field still derive (see finalizeCaseAttempt).
  attemptId?: string;
  // This attempt could not isolate its recording buffer — it runs, but its replay is not claimed as ours.
  unisolated?: boolean;
  // The judges this batch SELECTED. Carried so the commit can state the absence of one that never answered
  // rather than leaving the row silent about it (review 39 P0-3) — the same invariant the Temporal path holds.
  judges: ReadonlyArray<{ id: string }>;
  // …and the SEALED closure those judges resolved to at submit (specDigest/model/rubric digests) — what the
  // receipt's judgeClosureDigest names, so "which judgment produced this outcome" is the manifest's answer,
  // not a list of id strings (review 40 follow-up P1).
  sealedJudges?: SealedJudgeClosure[];
}

// A case the in-process loop sent down the FAILURE exit — what the judged exit needs to finalize it
// ATOMICALLY once the failure is known final (arch-review 41 P0-lifecycle). The dispatch catch no longer
// terminalizes the child itself: a retryable throw would re-open the case anyway, and terminal-first left a
// window (terminal child, no receipt) a crash turned into a re-execution and a takeover turned into an
// unfenced claim. The child stays OPEN until the judged exit commits receipt + terminal write in one
// transaction — the same commit point every other outcome uses.
export interface FailureFinalization {
  childId?: string;
  executionId: string;
  generation?: number;
  // The failed attempt's ledger row by name — same rule as PendingChildSettle.attemptId (arch-review 51).
  attemptId?: string;
  // The batch this attempt ran under — the fence the atomic commit must re-prove inside the transaction.
  parentDriver: { scorecardId: string; epoch: number };
  // What the dispatch could not isolate (see PendingChildSettle.unisolated) — a failure seals no replay then.
  unisolated?: boolean;
  // The failure as the catch saw it — the abandon-settle of a superseded attempt's child needs it verbatim.
  error: { code: string; message: string };
  // The judge selection + sealed closure, same as the judged exit's pending entry: a failure receipt names
  // the judgment identity too (pre-fix it carried no judgeClosureDigest — an asymmetry with no reason).
  judges: ReadonlyArray<{ id: string }>;
  sealedJudges?: SealedJudgeClosure[];
}

export class CaseOutcomeCommitter {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly deps: CaseOutcomeCommitterDeps,
    shared: { newId: () => string; now: () => string },
  ) {
    this.newId = shared.newId;
    this.now = shared.now;
  }

  // The child's ONE terminal write, carrying the result as it now stands — execution plus whatever the judges
  // attached to it (a failed judge leaves its `unmeasured` row, which is evidence too). Idempotent: the entry
  // is consumed, so a second call after a retried stream does nothing.
  //
  // THE PENDING MAP IS THE BATCH'S, NOT THE SERVICE'S (arch-review 34 P0). It was an instance field keyed by
  // `caseId#trial` — no tenant, no scorecard — and one `ScorecardService` drives every batch in the process.
  // Two batches with a case of the same name (`c1`, which is what half the datasets in the world call their
  // first case) overwrote each other's entry: one child settled with the OTHER batch's result, under the
  // OTHER batch's parent fence, and the second settle found nothing pending and never settled at all. Across
  // workspaces, that is one tenant's evidence written onto another tenant's row. The state is per-batch
  // because the thing it describes is: it now lives in the `track` call that owns those cases.
  // Everything a case produces, assembled onto its result before the ONE terminal write that publishes it:
  // the offloaded snapshot and the sealed replay, both under the ATTEMPT that produced them. Shared by the
  // in-process loop and the Temporal driver, because a case's evidence should not depend on which driver a
  // deployment happens to run — that difference is how "terminal means finalized" was true on one path and
  // false on the other for a whole review.
  //
  // Best-effort by contract: a failed offload or an unsealed recording must never cost a case its verdict.
  private async assembleCaseEvidence(
    result: CaseResult,
    // `generation` absent = the attempt never opened one (arch-review 46): the snapshot stays INLINE rather
    // than staged under a fabricated `#g0` key — the execution id is stable across a re-drive by
    // construction, so two unisolated attempts of one case would share one object key with no CAS beneath.
    where: { scorecardId: string; executionId: string; generation?: number; unisolated?: boolean },
  ): Promise<void> {
    if (this.deps.artifacts && where.generation !== undefined) {
      try {
        // Keyed by the ATTEMPT, not by the case (arch-review 37 P0). `scorecards/<id>/<caseId>` gave every
        // trial of a case one object key, so trial 1 overwrote the bytes trial 0's result still points at —
        // an execution id was stamped on the row and then not used for the artifact it names.
        // Keyed by the attempt, GENERATION INCLUDED (arch-review 38 P0). `attempts/<executionId>` is stable
        // across a re-drive by construction — that is what an execution id is for — so a stale attempt's
        // offload overwrote the bytes the winner's result already points at. The generation is the part that
        // differs between two attempts of one case.
        result.snapshot = await offloadSnapshot(
          result.snapshot,
          this.deps.artifacts,
          `attempts/${attemptIdOf(where.executionId, where.generation)}`,
        );
      } catch {}
    }
    // …unless this attempt could not isolate its buffer (see `unisolated`): sealing then would publish an
    // earlier attempt's frames as this result's replay, which is worse than having none.
    if (this.deps.recordingStore && !where.unisolated && where.generation !== undefined) {
      try {
        await foldEnvDeltas(this.deps.recordingStore, where.executionId, result, where.generation);
        const ref = await this.deps.recordingStore.seal(
          where.executionId,
          { envKind: result.snapshot.kind, dispatch: dispatchManifest(result.harness) },
          where.generation,
        );
        if (ref) result.recordingRef = ref;
      } catch {}
    }
  }

  // `committed` — this case's evidence is on the ledger, and everything downstream may derive from it.
  // `lost` — a takeover or a cancel took the case: not ours, and not a failure of anything.
  // `unwritten` — we could not write it. That distinction is the point (arch-review 37 P0): a parent that
  // SUCCEEDS while one of its cases never reached the ledger is a scorecard whose summary counts a result no
  // reader can find, because the aggregate was built from this process's memory and the ledger disagrees.
  async settleJudgedChild(
    scorecardId: string,
    tenant: string,
    announce: { verdictPolicy?: VerdictPolicy; owner?: string },
    pending: Map<string, PendingChildSettle>,
    finalized: Map<string, FailureFinalization>,
    result: CaseResult,
  ): Promise<"committed" | "lost" | "unwritten"> {
    const key = childKey(result.caseId, result.trial);
    // This loop sent it down the failure exit, and runSuite has now frozen the failure as FINAL — the child
    // is still OPEN (the catch terminalizes nothing, arch-review 41 P0-lifecycle). So the failure commits
    // through the SAME atomic commit point as every other outcome: receipt + fenced terminal fail-write in
    // one transaction, judge coverage stated, evidence assembled, completion fact riding the commit.
    const failure = finalized.get(key);
    if (failure) {
      // A ledger is wired and this exit has no child row to commit (the create itself threw): the case is
      // counted in memory and cannot be accounted on the ledger — `unwritten` is the honest answer (the
      // batch refuses to summarize, recoverable), exactly as the raw failure receipt answered before.
      if (!failure.childId && this.deps.runStore && this.deps.caseReceipts) return "unwritten";
      const outcome = await this.finalizeCaseAttempt({
        scorecardId: failure.parentDriver.scorecardId,
        epoch: failure.parentDriver.epoch,
        result,
        outcome: "failed",
        error: failure.error,
        judges: failure.judges,
        ...(failure.sealedJudges ? { sealedJudges: failure.sealedJudges } : {}),
        tenant,
        announce,
        ...(failure.childId ? { childId: failure.childId } : {}),
        executionId: failure.executionId,
        ...(failure.generation !== undefined ? { generation: failure.generation } : {}),
        ...(failure.attemptId !== undefined ? { attemptId: failure.attemptId } : {}),
        ...(failure.unisolated ? { unisolated: true } : {}),
      });
      if (outcome.kind === "committed") result.scores = outcome.result.scores;
      return outcome.kind;
    }
    const entry = pending.get(key);
    if (!entry) return "lost"; // never ours, or a second call for one case
    pending.delete(key);
    // Everything that "ending a case" MEANS lives in one place now (see finalizeCaseAttempt); what is left
    // here is this loop's own bookkeeping — which case, and whether it already ended.
    const outcome = await this.finalizeCaseAttempt({
      scorecardId: entry.parentDriver.scorecardId,
      epoch: entry.parentDriver.epoch,
      result,
      judges: entry.judges,
      ...(entry.sealedJudges ? { sealedJudges: entry.sealedJudges } : {}),
      tenant,
      announce,
      ...(entry.childId ? { childId: entry.childId } : {}),
      executionId: entry.executionId,
      ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
      ...(entry.attemptId !== undefined ? { attemptId: entry.attemptId } : {}),
      ...(entry.unisolated ? { unisolated: true } : {}),
      ...(entry.ranOn ? { ranOn: entry.ranOn } : {}),
    });
    // …and the PARENT counts what the child carries. Judge coverage may have added rows, and the aggregate
    // holds this very object — so a summary built from it would otherwise disagree with the ledger about a
    // judge that never answered, which is the disagreement this whole seam exists to prevent.
    if (outcome.kind === "committed") result.scores = outcome.result.scores;
    return outcome.kind;
  }

  // ── THE RECEIPT NAMES WHAT THE CHILD WILL CARRY (review 39 P0 · review 40 P0) ────────────────────────
  //
  // A pure builder: the claim itself is `commitCase` now — one transaction with the child's terminal write.
  // The digest is computed over the result AS IT WILL BE PERSISTED, which is why every caller builds the
  // receipt AFTER `assembleCaseEvidence`: the assembly mutates the result (snapshot refs, recordingRef), and
  // a digest taken before it named bytes no row ever carried — the parity check then reported a divergence
  // on every case with an offloaded snapshot, which is a diagnostic crying wolf.
  //
  // `generation` is optional because one caller genuinely does not know it: a RECOVERY adopting a result
  // from a backend never opened the attempt that produced it. An unknown attempt number is recorded as
  // absent rather than as 0 — 0 is a real generation, and claiming to know is worse than saying nothing.
  receiptOf(
    scorecardId: string,
    result: CaseResult,
    entry: {
      childId: string;
      // The outcome ledger's discriminant (arch-review 42): executed | failed | inherited. Every producer
      // states it — only pre-discriminant rows read as absent.
      kind: NonNullable<CaseCommitReceipt["kind"]>;
      // Required with kind "inherited": the batch whose execution the carried result actually is.
      sourceScorecardId?: string;
      executionId?: string;
      generation?: number;
      // The attempt's NAME as the committer was TOLD it (arch-review 52), when a caller holds one. It is the
      // answer in the case the derivation below cannot serve: an UNISOLATED attempt has a ledger row and no
      // generation, so the receipt for the execution that most needs naming was the one receipt that named
      // nothing. Absent ⇒ the pair still spells it, exactly as before.
      attemptId?: string;
      judges: ReadonlyArray<{ id: string }>;
      sealedJudges?: SealedJudgeClosure[];
    },
  ): CaseCommitReceipt {
    // The joined identity, so a reader comparing a receipt with a sealed replay or an artifact key compares
    // STRINGS rather than re-deriving the pair and hoping both sides did it the same way. The CARRIED name
    // wins where the caller has one — it is what the ledger actually minted, and it is present precisely
    // where the derivation has nothing to work with (an unisolated attempt, arch-review 52). Where neither
    // exists the field is OMITTED: this receipt was made by a caller who never opened the attempt.
    const attemptId =
      entry.attemptId !== undefined
        ? entry.attemptId
        : entry.executionId !== undefined && entry.generation !== undefined
          ? attemptIdOf(entry.executionId, entry.generation)
          : undefined;
    return {
      scorecardId,
      caseId: result.caseId,
      trial: result.trial ?? 0,
      childRunId: entry.childId,
      kind: entry.kind,
      ...(entry.sourceScorecardId !== undefined ? { sourceScorecardId: entry.sourceScorecardId } : {}),
      ...(entry.executionId !== undefined ? { executionId: entry.executionId } : {}),
      ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
      // Through the ONE spelling (caseResultDigest): the digest must match across the jsonb round-trip —
      // ScoreSchema's read-time normalizer reshapes what a producer literally wrote (see case-result-digest.ts).
      resultDigest: caseResultDigest(result),
      // …and the execution's own digest, invariant under re-judgment (arch-review 41 P1): a later re-score
      // replaces scores in place, so resultDigest diverges from the row — this one is what "still the
      // execution the receipt vouches for" compares from then on.
      observationDigest: caseObservationDigest(result),
      // The judge-closure identity: the SEALED closure when the manifest carries one (each entry pins the
      // judge document and its nested model/rubric/harness digests — the whole judgment, not its name), and
      // only a batch that sealed nothing falls back to the bare id list. Sorted by id so the digest is a
      // set identity, not an ordering accident.
      ...(entry.sealedJudges && entry.sealedJudges.length > 0
        ? { judgeClosureDigest: contentDigest([...entry.sealedJudges].sort((a, b) => (a.id < b.id ? -1 : 1))) }
        : entry.judges.length > 0
          ? { judgeClosureDigest: contentDigest(entry.judges.map((j) => j.id).sort()) }
          : {}),
      committedAt: this.now(),
    };
  }

  // ── THE ONE PLACE A CASE IS FINALIZED (review 39, Phase 2) ───────────────────────────────────────────
  //
  // Both drivers used to hold their own copy of "what ending a case means", and every review since has found
  // the same defect in whichever copy was edited second: the Temporal path settled without assembling, the
  // in-process path claimed without covering its judges, one honoured the settle's answer and the other threw
  // it away. Reviewing them separately is what made the recurrence structural.
  //
  // So the ORDER is stated once, and it is the whole content of the contract:
  //
  //   ① complete the judge coverage — a selected judge that never answered leaves a stated row, not silence
  //   ② assemble the evidence — snapshot offload + recording seal, staged under the attempt's OWN key
  //      (`attempts/<attemptId>`), so a concurrent attempt's staging never overwrites a winner's bytes: a
  //      loser's artifacts become unreferenced orphans, not corruption
  //   ③ COMMIT — the receipt claim and the child's one terminal write, in ONE transaction (review 40 P0).
  //      As two writes, a claim whose child settle was then refused poisoned the case forever: canonical
  //      right acquired, canonical artifact never recorded. Claiming the right to commit is not the commit.
  //
  // ② before ③ is what makes the receipt's digest TRUE: the assembly mutates the result (snapshot refs,
  // recordingRef), and the digest must name the bytes the child row will actually carry.
  //
  // The result is what the caller must persist and count — coverage may have added rows to it — so it is
  // returned rather than mutated in place.
  async finalizeCaseAttempt(input: {
    scorecardId: string;
    epoch: number;
    result: CaseResult;
    // Which terminal transition this commit applies — the SAME transaction shape either way (arch-review 41
    // P0-lifecycle): receipt claim + fenced terminal write, all-or-nothing. Default "succeeded".
    outcome?: "succeeded" | "failed";
    // The failure as the exit recorded it — required with outcome "failed" (the fail transition names it).
    error?: { code: string; message: string };
    judges: ReadonlyArray<{ id: string }>;
    sealedJudges?: SealedJudgeClosure[];
    childId?: string;
    executionId: string;
    // Absent when the attempt never opened one (fail-closed: nothing seals then — see assembleCaseEvidence).
    generation?: number;
    // WHICH LEDGER ROW to terminalize, said rather than derived (arch-review 51). EXPLICIT WINS: the caller
    // holding the open's answer knows the row, and it is the only thing that can name an UNISOLATED attempt
    // (a row with no generation). The derivation below stays as the fallback for callers that predate the
    // field — for a generation-carrying attempt the two are equal by construction (`open` mints the ordinal
    // and the row's id IS `attemptIdOf(executionId, generation)`), so this is a widening, not a second
    // authority. ⚠️ A caller passing both must pass ONE attempt's pair: a name from one execution beside
    // another's generation would terminalize the wrong row and seal under the right one.
    attemptId?: string;
    unisolated?: boolean;
    ranOn?: string;
    // The completion FACT's ingredients (review 40 follow-up, E0): with a ledger, the fact rides the commit
    // transaction itself — persisted if and only if the case committed, so a loser structurally announces
    // nothing; without one, it falls back to the best-effort emit this fact always had.
    tenant?: string;
    announce?: { verdictPolicy?: VerdictPolicy; owner?: string };
  }): Promise<{ kind: "committed"; result: CaseResult } | { kind: "lost" } | { kind: "unwritten" }> {
    const covered =
      input.judges.length > 0
        ? { ...input.result, scores: completeJudgeCoverage(input.result.scores, input.judges) }
        : input.result;
    const completionFact = (): { message: string; fact: DomainFact & { message: string; recipient?: string } } => {
      const v = caseVerdict(covered, input.announce?.verdictPolicy);
      const reason = caseReason(covered);
      const verdict = v == null ? "no result" : v ? "PASS" : "FAIL";
      const message = `Scorecard ${input.scorecardId} case ${covered.caseId} → ${verdict}${reason ? ` · ${reason}` : ""}`;
      return {
        message,
        fact: {
          kind: "scorecard.case.completed",
          subject: { type: "scorecard", id: input.scorecardId },
          payload: {
            caseId: covered.caseId,
            ...(covered.trial !== undefined ? { trial: covered.trial } : {}),
            verdict: v ?? null,
            ...(reason !== undefined ? { reason } : {}),
          },
          message,
          ...(input.announce?.owner !== undefined ? { recipient: input.announce.owner } : {}),
        },
      };
    };
    // A batch with no run store has no child to commit — the case really did finish, and there is nothing for
    // a receipt to make canonical either. The fact keeps its historical best-effort emit here.
    const runStore = this.deps.runStore;
    const childId = input.childId;
    if (!childId || !runStore) {
      // A wired ledger with no child row to commit cannot account for the case — refusing to summarize is
      // the honest answer, never a receipt for a child that does not exist.
      if (runStore && this.deps.caseReceipts) return { kind: "unwritten" };
      if (input.announce && input.tenant !== undefined) {
        const { fact } = completionFact();
        void this.deps.events?.emit({ workspace: input.tenant, ...fact });
      }
      return { kind: "committed", result: covered };
    }
    const stamped =
      input.announce && input.tenant !== undefined
        ? stampFacts(input.tenant, [completionFact().fact], { newId: this.newId, now: this.now })
        : [];
    await this.assembleCaseEvidence(covered, {
      scorecardId: input.scorecardId,
      executionId: input.executionId,
      // An attempt that never opened a generation must not seal generation 0's buffer as its replay —
      // 0 is a real generation; "unknown" is `unisolated`, the same fail-closed answer the dispatch gives.
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.unisolated || input.generation === undefined ? { unisolated: true } : {}),
    });
    // The constructor guard couples the receipt store to the run store, so this branch is unreachable in a
    // wired service — and if a wiring ever uncouples them, refusing the commit is the only honest answer.
    const receipts = this.deps.caseReceipts;
    if (!receipts) return { kind: "unwritten" };
    const failureError = input.error ?? { code: "INTERNAL", message: "case failed" };
    // WHICH PHYSICAL ATTEMPT this commit is made by — the same spelling the receipt records, so the two
    // ledgers can be compared rather than assumed to agree (arch-review 42). Absent when no attempt was
    // minted; there is then no row to stamp, and inventing a coordinate would address somebody else's.
    const attemptId =
      input.attemptId ??
      (input.generation === undefined ? undefined : attemptIdOf(input.executionId, input.generation));
    // `failed` is a terminal outcome of a REAL execution, not a supersede: the case ended here, with this
    // attempt's frozen failure as the answer.
    const terminalState: ExecutionAttemptState = input.outcome === "failed" ? "failed" : "committed";
    const outcome = await receipts
      .commitCase(
        this.receiptOf(input.scorecardId, covered, {
          childId,
          kind: input.outcome === "failed" ? "failed" : "executed",
          executionId: input.executionId,
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          // …under the SAME name the ledger stamp below uses (arch-review 52). The receipt used to re-derive
          // it from (executionId, generation) on its own, so an unisolated attempt — the one case where the
          // stamp had a name and the pair did not — committed a receipt that named no attempt at all, while
          // the row it terminalized right beside it did. Two ledgers, one commit, one coordinate.
          ...(attemptId !== undefined ? { attemptId } : {}),
          judges: input.judges,
          ...(input.sealedJudges ? { sealedJudges: input.sealedJudges } : {}),
        }),
        async (runs, attempts) => {
          const settled = await this.settleChildOn(
            runs,
            childId,
            (cur) =>
              input.outcome === "failed"
                ? // The failure transition, WITH the frozen failure result — the same bytes the parent counts
                  // and the receipt's digest names (failedCaseResult is pure over (job, err), so runSuite's
                  // copy and this one are identical).
                  Run.from(cur).fail(failureError, this.now(), covered).patch
                : {
                    ...Run.from(cur).succeed(covered, this.now()).patch,
                    // Provenance: the runtime that ACTUALLY ran the case (differs from the assigned one after a spillover).
                    ...(input.ranOn ? { runtime: input.ranOn } : {}),
                  },
            { scorecardId: input.scorecardId, epoch: input.epoch },
            stamped.length > 0 ? stamped.map((f) => f.record) : undefined,
          );
          // ── THE ATTEMPT'S TERMINAL STAMP RIDES THE COMMIT (arch-review 43) ─────────────────────────────
          //
          // Phase 1 stamped this AFTER the commit resolved, best-effort: a crash in that window left a
          // committed receipt beside an attempt row still saying `created` — a receipt naming an execution
          // the physical ledger never saw end. Inside the transaction it is the same decision as the receipt
          // and the child's terminal write, so there is no window to crash in and no `.catch` to hide a
          // ledger that could not record what the receipt claims.
          //
          // AFTER the settle, never before: a refused fence returns here and the stamp must not have said
          // "committed" about an attempt that lost (the in-memory twin has no rollback to undo it with). The
          // transition's own answer is deliberately not read — a refusal is a silent no-op by contract (an
          // idempotent re-commit meeting its own terminal row is the ordinary case), and only a THROW, which
          // is a store fault, aborts the commit.
          //
          // TWO CONDITIONS, and they ask different questions: `this.deps.attempts` is whether this service
          // has a ledger AT ALL (an adapter that can always build a transaction-bound twin would otherwise
          // stamp a plane the deployment was configured without), and `attempts` is the store the write must
          // go through — the transaction's twin wherever one exists.
          if (settled === undefined) return undefined;
          if (this.deps.attempts && attempts && attemptId !== undefined)
            await attempts.transition(attemptId, terminalState, {
              childRunId: childId,
              ...(input.outcome === "failed" ? { error: failureError } : {}),
            });
          return settled;
        },
        runStore,
        this.deps.attempts,
      )
      .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    if (outcome instanceof Error) return { kind: "unwritten" }; // the store could not take it — the batch must not pass
    if (outcome.kind === "committed") {
      // The fact is already persisted (it rode the commit transaction); this is only the live-bus nudge.
      // An idempotent re-claim (already_committed below) pushes nothing — the first commit already did.
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      // …and the attempt reached its terminal state inside that same transaction (see the settle above).
      return { kind: "committed", result: covered };
    }
    if (outcome.kind === "already_committed") {
      // The idempotent retry (a Temporal activity re-running its own commit) is a success; any OTHER child
      // owning the case means a concurrent attempt won — this one was never the case's answer.
      if (outcome.receipt.childRunId === childId) {
        // Best-effort, and it stays that way: THIS call's transaction never ran (the claim was already
        // there), so there is nothing for the stamp to ride. The winning commit — the first one — stamped
        // this attempt inside its own transaction; a row that pre-dates the promotion is repaired here, a
        // row that does not is refused as already terminal. Either way it is diagnostic, not the decision.
        await this.stampAttempt(attemptId, terminalState, {
          childRunId: childId,
        });
        return { kind: "committed", result: covered };
      }
      // A LOSER'S STAMP CANNOT RIDE A TRANSACTION, because the loser never had one: its claim was refused
      // before any settle ran (`already_committed`), or its transaction rolled back whole (`unsettled`). So
      // the two supersede stamps below stay best-effort — a diagnostic saying which attempts ran and lost.
      // The WINNER's stamp is the one the commit carries, and losing that one is what may never be swallowed.
      await this.stampAttempt(attemptId, "superseded");
      return { kind: "lost" };
    }
    // `unsettled` — the child's fence refused (takeover / cancel / already terminal) and the claim rolled
    // back with it: the case belongs to whoever holds the authority now.
    await this.stampAttempt(attemptId, "superseded");
    return { kind: "lost" };
  }

  async settleChild(
    childId: string,
    settle: (current: RunRecord) => Partial<RunRecord>,
    parentDriver?: { scorecardId: string; epoch: number },
  ): Promise<RunRecord | undefined> {
    const store = this.deps.runStore;
    if (!store) return undefined;
    return this.settleChildOn(store, childId, settle, parentDriver);
  }

  private async settleChildOn(
    // The store this settle must go through — commitCase hands a TRANSACTION-BOUND twin so the child's
    // terminal write commits or rolls back with the receipt claim (review 40 P0).
    store: RunStore,
    childId: string,
    settle: (current: RunRecord) => Partial<RunRecord>,
    // The batch this child belongs to, and the epoch its driver holds. Proved INSIDE the write: the child's
    // own epoch cannot answer "am I still this batch's driver" (arch-review 33 P0).
    parentDriver?: { scorecardId: string; epoch: number },
    // Outbox facts that ride the SAME write (E0): inside commitCase this is the same transaction as the
    // receipt claim, so "the case completed" is persisted if and only if the case actually committed.
    events?: OutboxEvent[],
  ): Promise<RunRecord | undefined> {
    const current = await store.get(childId);
    if (!current || Run.from(current).isTerminal()) return undefined;
    // …and the CONDITION travels with the write (Tier B, the cancel/completion race). The read above builds
    // the patch and answers "is there anything to do"; it cannot answer "is this row still open", because the
    // other writer is in another process — a user's cancel in the control plane against a case drain landing
    // from a worker. Read-check-write made the LAST write win, which is the exact inverse of the rule this
    // method is named after.
    // …under the child's own epoch AND the parent's driver. The first refuses a child somebody claimed
    // directly; the second refuses a driver that lost the BATCH — two different takeovers, and the child's
    // number moves for only one of them.
    //
    // The ANSWER is returned, because everything a finished case does next — announcing it, exporting it,
    // counting it done — is authority the committed transition owns and the attempt does not (arch-review 35
    // P1). Swallowing it made "the judges are done" the licence, which is one step short of the truth.
    return await settleRun(store, childId, settle(current), events, {
      epoch: current.ownerEpoch ?? 0,
      ...(parentDriver ? { parentDriver } : {}),
    });
  }

  // ── THE PHYSICAL ATTEMPT'S STATE, WHERE NO COMMIT TRANSACTION EXISTS TO RIDE (arch-review 42 · 43) ──
  //
  // The WINNER's terminal stamp no longer comes through here: it rides the case commit itself, inside the
  // transaction that makes the receipt (finalizeCaseAttempt's settle closure), where a throw aborts the
  // commit instead of being swallowed. What is left on this path is every stamp that HAS no transaction to
  // ride — `executing` (no commit is being made), a loser's `superseded` (its transaction never ran or
  // rolled back whole), a retry's abandon stamp (the abandoned attempt commits nothing). Those are
  // diagnostics: they name what ran, and no outcome is derived from them, which is why they may be swallowed.
  //
  // `attemptId` is absent when no attempt was minted (no ledger wired, or an execution that never opened a
  // generation): there is no row to stamp, and inventing a coordinate would address somebody else's.
  async stampAttempt(
    attemptId: string | undefined,
    to: ExecutionAttemptState,
    patch?: { childRunId?: string; unisolated?: boolean; error?: { code: string; message: string } },
  ): Promise<void> {
    const attempts = this.deps.attempts;
    if (!attempts || attemptId === undefined) return;
    await attempts.transition(attemptId, to, patch).catch(() => {});
  }

  // WHERE this attempt's compute WILL BE, written before it exists (arch-review 52 Wave 2; the proof is
  // arch-review 54 Phase 1). The handle names its own attempt — the dispatched job carries `attemptId`, and
  // the backend copies it onto the handle — so this needs no map.
  //
  // NOT swallowed (arch-review 53, Wave A). It is called from the reservation hook, BEFORE the cluster is
  // asked for anything, so a rejection here costs a dispatch that has not happened — and buys the guarantee
  // that no external object exists whose name the ledger does not hold. The old ordering had no such choice:
  // the stamp ran after the apply, so failing it would have failed a dispatch that had already placed compute.
  //
  // AND IT RETURNS THE PROOF. The two early returns it used to take — no ledger wired, no attempt id on the
  // handle — resolved successfully, which told the backend the reservation had been recorded when nothing had
  // been. Both are now refusals, because both describe a dispatch that cannot be addressed afterwards: a
  // managed lane reaching this point without a ledger row is the composition error `openPhysicalAttempt`
  // already refuses, and this is the second place it would otherwise slip through.
  async reserveWork(work: RuntimeWorkRef): Promise<PersistedWorkIntent> {
    const attempts = this.deps.attempts;
    if (!attempts)
      throw new InternalError(
        "NOT_CONFIGURED",
        { runId: work.runId },
        "no execution-attempt ledger is wired, so there is nowhere to record where this work will be placed.",
      );
    if (work.attemptId === undefined)
      throw new InternalError(
        "NOT_CONFIGURED",
        { runId: work.runId, externalJobId: work.externalJobId },
        "the reserved work names no attempt, so nothing durable would point at the job about to be created.",
      );
    return await attempts.reserveWork(work.attemptId, work);
  }

  // Flip a fan-out child run queued→running when its case actually begins executing (the onStarted hook fires on
  // managed dispatch / self-hosted lease). Best-effort and idempotent: acts only on a still-queued child (a re-fire
  // from spillover/speculation, or a race with settlement, is a no-op), and a store error never disturbs the run.
  // First terminal write wins: a child settled by cancel (failed{CANCELLED} via stopInFlight) must not be
  // resurrected or rewritten by a late-landing drain — the killed dispatch's rejection, or a case that was
  // already past the point of no return when the user stopped the batch. The transition is built from the
  // CURRENT record (never the creation-time snapshot) so the domain's terminal guard sees the truth.
  async markChildRunning(childId: string): Promise<void> {
    const store = this.deps.runStore;
    if (!store) return;
    try {
      const rec = await store.get(childId);
      if (!rec || rec.status !== "queued") return; // already running/terminal — nothing to flip
      await store.update(childId, Run.from(rec).start(this.now()).patch, undefined, { expectNonTerminal: true });
    } catch {
      // Best-effort visibility flip — a failure here must never break the case (the run still executes and settles).
    }
  }
}
