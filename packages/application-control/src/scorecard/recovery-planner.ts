import type { AdoptionDecision, CaseResult, Dataset, ReadResult, RuntimeWorkRef } from "@everdict/contracts";
import { UpstreamError, readOrUnknown } from "@everdict/contracts";
import { initialScoringPassId } from "@everdict/domain";
import { Run, ScorecardBatch, completeJudgeCoverage } from "@everdict/domain";
import type { ScoringService, SealedJudgeClosure } from "../execution/scoring-service.js";
import { settleRun } from "../ports/settle.js";
import type { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";

// ── WHAT THE LEDGER ALREADY ANSWERS FOR THIS BATCH (arch-review 47 §4) ───────────────────────────────
//
// The re-drive half of the batch service, extracted unchanged: which cases a resumed or re-planned batch
// must NOT run again, and what happens to the children that were mid-flight when the process died. Both
// answers come from the same rule — a case is answered when a receipt says which attempt answered it, never
// when a row happens to be newest (review 39, Phase 4) — and having them in one file is what keeps the two
// callers from drifting the way resume and the Temporal plan drifted before ExecutionPlan existed.
//
// It DECIDES nothing about authority: the fence a recovery holds is the driver's, so the parent token and
// the "do I still hold this batch" probe are handed in per call rather than re-derived here.

type RecoveryPlannerDeps = Pick<ScorecardBatchDeps, "runStore" | "caseReceipts" | "adoptWork" | "attempts">;

export class RecoveryPlanner {
  private readonly now: () => string;

  constructor(
    private readonly deps: RecoveryPlannerDeps,
    private readonly scoring: ScoringService,
    private readonly commit: CaseOutcomeCommitter,
    shared: { now: () => string },
  ) {
    this.now = shared.now;
  }

  // The finished cases a resume carries in verbatim, and the mid-flight children it adopts or interrupts on
  // the way there. Returns the seed the rebuilt batch starts from — the caller re-dispatches everything else.
  async seedFromLedger(input: {
    scorecardId: string;
    tenant: string;
    // The re-resolved selection, already graded by the recorded plan: what is still IN the batch decides
    // which of the ledger's answers may be seeded at all.
    dataset: Dataset;
    judges: Array<{ id: string; version: string }>;
    sealedJudges?: SealedJudgeClosure[];
    runtime?: string;
    createdBy?: string;
    // The parent token this recovery won, or absent for a manual re-drive with no claim behind it.
    parentDriver?: { scorecardId: string; epoch: number };
    // …and the probe that says it is still held — publishing is the caller's authority, not this planner's.
    holdsBatch?: () => Promise<boolean>;
  }): Promise<{ seed: CaseResult[]; seedRunIds: string[]; adopted: number }> {
    const { scorecardId: id, tenant, dataset, judges, parentDriver } = input;
    let seed: CaseResult[] = [];
    const seedRunIds: string[] = [];
    let adopted = 0;
    if (this.deps.runStore) {
      const children = await this.deps.runStore.list(tenant, { scorecardId: id });
      // WHICH child is this case's answer: the receipt, and only the receipt (review 39, Phase 4). A
      // resume that seeded "the newest row" could carry a superseded attempt's result into the rebuilt
      // batch — and a case with no receipt has no answer at all, so it is simply re-dispatched below,
      // which is what an uncommitted case means.
      // No `.catch(() => [])`: a receipt read that fails must fail the resume (it is retried), not read as
      // "nothing committed" — which re-dispatched every finished case of the batch (review 40 P0).
      const committedReceipts = (await this.deps.caseReceipts?.list(id)) ?? [];
      const canonical = ScorecardBatch.canonicalChildPerCase(children, committedReceipts);
      const committedIds = new Set([...canonical.values()].map((c) => c.id));
      // EVERY child is examined, and only the COMMITTED ones are evidence. Two different questions that
      // used to be one: "which row is this case's answer" (the receipt) and "which rows are still running
      // and must be adopted or interrupted" (all of them). Iterating the canonical map alone left a
      // mid-flight child of an uncommitted case untouched — parented to the batch and running forever.
      for (const c of children) {
        // TERMINAL + RESULT IS FINISHED EVIDENCE, whatever the status says (arch-review 30 P1). The
        // symmetric half of "terminal + no result is unfinished work": a case can settle FAILED and still
        // carry a complete CaseResult — the write-back attaches one to a failed child on purpose, because
        // a failed case is a measured outcome, not a missing one. Seeding only `succeeded` re-ran those
        // cases on resume, and the abandoned attempt stayed parented to the batch.
        //
        // …and COMMITTED is now part of that sentence (review 39, Phase 4): a terminal child no attempt
        // committed is a superseded execution, so it is left where it is and its case is re-dispatched.
        if (committedIds.has(c.id) && c.result) {
          seed.push(c.result);
          seedRunIds.push(c.id);
        } else if (c.status === "running" || c.status === "queued") {
          // Mid-flight when the process died. ADOPT first: the orchestrator job the old process submitted may
          // still be running (or already finished) — harvest its result instead of re-dispatching and paying
          // for the same execution twice. Only when nothing is adoptable does the case fall to re-dispatch.
          // BY THE HANDLE the attempt ledger recorded (arch-review 53, legacy removal). A child with none
          // has no managed work this system can name — it falls to re-dispatch, which is what the case-id
          // resolution was there to avoid and what it could not do safely: it harvested "the newest job of
          // this case", i.e. possibly another run's, and adoption ATTRIBUTES what it harvests.
          //
          // …AND THE LEDGER READ IS THREE-VALUED TOO (arch-review 54, Phase 2). `.catch(() => [])` turned an
          // unreadable attempt ledger into "this case placed no compute", which routes to re-dispatch — the
          // same collapse the standalone-run path had, one lane over. A batch resuming on an unreadable
          // ledger would re-run every case whose job is still live.
          const handlesRead = this.deps.attempts
            ? await readOrUnknown(
                () =>
                  this.deps.attempts
                    ? this.deps.attempts
                        .list(c.id)
                        .then((rows) => rows.flatMap((a) => (a.runtimeWork ? [a.runtimeWork] : [])))
                    : Promise.resolve([]),
                `the attempt handles of case ${c.id}`,
              )
            : ({ kind: "absent" } as ReadResult<RuntimeWorkRef[]>);
          if (handlesRead.kind === "unknown")
            // The plan CANNOT BE MADE, so none is returned. Skipping the case would be worse than useless:
            // a case that is not seeded is re-dispatched, which is exactly the double-spend this read
            // protects against.
            //
            // ⚠️ THE COMMENT THAT USED TO BE HERE WAS WRONG (arch-review 55). It said the caller "already
            // treats a throw here as 'not faithfully resumable' and leaves the batch for the next sweep".
            // It did not: `resume` caught everything into `false`, and the sweep read `false` as
            // TOMBSTONE — so this refusal, added to prevent a double-spend, recorded the batch as
            // `failed{INTERRUPTED}` while its jobs were still running. The type is what fixed it: `resume`
            // answers `retry_later` for an UpstreamError and the sweep leaves the row alone. The lesson is
            // rule `protocol` L2's: a throw is not a third value, it is whatever the nearest catch means.
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { scorecardId: id, caseId: c.caseId },
              `cannot plan this batch's resume: ${handlesRead.reason}. Re-dispatching a case whose compute may still be live would double-spend it.`,
            );
          const handles = handlesRead.kind === "read" ? handlesRead.value : [];
          let adoptable: CaseResult | undefined;
          let unestablished: string | undefined;
          for (const work of handles) {
            const decision = await this.deps.adoptWork?.call(this.deps, tenant, c.runtime ?? input.runtime, work).catch(
              (err: unknown): AdoptionDecision => ({
                kind: "unknown",
                reason: err instanceof Error ? err.message : String(err),
              }),
            );
            // Exhaustive: `unknown` means this case's job may still be running, so it is neither adopted nor
            // re-dispatched — it waits.
            if (decision?.kind === "adopted") {
              adoptable = decision.result;
              break;
            }
            if (decision?.kind === "unknown") {
              unestablished = decision.reason;
              break;
            }
          }
          if (unestablished !== undefined)
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { scorecardId: id, caseId: c.caseId },
              `cannot plan this batch's resume: ${unestablished}. This case's job may still be running, and a case left unseeded is re-dispatched.`,
            );
          // A REJECTED TRANSITION IS NOT REJECTED EVIDENCE (arch-review 28 P0). The CAS below correctly
          // refuses to overwrite a child that settled on its own between the list above and this write —
          // and the seed was pushed regardless, so the resumed batch could aggregate the harvested result
          // while the LEDGER held the real one. The two are usually equal and nothing here proves it: the
          // ledger row is what a reader sees a year later, so the ledger row is what the aggregate must be
          // built from.
          //
          // So when the CAS loses, the persisted truth decides — re-read the child and follow it.
          if (adoptable) {
            // WHAT A BACKEND HANDS BACK IS A RECOVERED EXECUTION, NOT FINISHED EVIDENCE (arch-review 34 P0).
            //
            // The in-process loop stopped terminalizing a child before its judges landed, and this branch —
            // the one that runs precisely when a control plane died mid-batch — went on adopting the raw
            // result straight into `succeeded` and seeding it. A seeded case is never re-dispatched and
            // never re-judged, so a batch recovered from a crash could complete with a case that met no
            // judge its own manifest names: no score, and no `unmeasured` row accounting for the absence.
            // The rule "terminal + result = finished evidence" was true again on one path and false on the
            // other, which is how it was wrong the first time.
            //
            // So the judges run here too, over the SAME sealed closure the batch was submitted under, and
            // the child settles with what they produced. Re-judging costs a provider call; seeding
            // unjudged evidence costs a verdict.
            // A JUDGE THAT FAILED AT THE TOP LEVEL IS NOT A JUDGED CASE (arch-review 38 P0). Swallowing it
            // here would terminalize the adopted result as finished evidence with no judge row at all —
            // the very shape re-judging on recovery was introduced to prevent. A per-judge failure still
            // becomes an `unmeasured` row inside the stream; this catch is for the stream itself dying,
            // and then the case is left OPEN for the next attempt rather than sealed as complete.
            let judged = true;
            if (judges.length > 0)
              judged = await this.scoring
                .applyJudges(
                  tenant,
                  dataset,
                  [adoptable],
                  judges,
                  input.runtime,
                  input.createdBy,
                  () => c.id,
                  input.sealedJudges,
                  // …publishable only while this recovery still holds the batch it is recovering.
                  input.holdsBatch,
                  // …UNDER THE BATCH'S OWN INITIAL PASS (arch-review 56, Wave E). This passed no scope, so a
                  // recovered case sealed a bare `judge:<id>` into a batch whose revision names
                  // `judge:<id>#initial:<sc>` — a receipt pointing at a plane nothing wrote. A recovery
                  // re-judges INTO the initial pass; it is the same decision, resumed, not a new one.
                  { passId: initialScoringPassId(id) },
                )
                .then(() => true)
                .catch(() => false);
            if (!judged) continue; // left active: the resume below re-dispatches it
            // THE SAME TWO INVARIANTS A COMMIT CARRIES ON EITHER DRIVER (review 39). A recovery is a third
            // path to a terminal child, and it held neither: an adopted case could go terminal with a
            // selected judge unmentioned, and with no receipt saying which attempt the batch counted — so
            // the parity check would report every recovered case as a disagreement, which is exactly the
            // kind of noise that makes a diagnostic useless.
            //
            // The evidence assembly is NOT repeated here: this result came back from a backend that
            // produced its own artifacts under an attempt this process never opened, and re-keying them
            // under a generation it would have to invent is worse than leaving them where they are.
            const adoptedResult =
              judges.length > 0 ? { ...adoptable, scores: completeJudgeCoverage(adoptable.scores, judges) } : adoptable;
            // ATOMIC, like every other commit (review 40 P0): the claim and the adopt-settle are ONE
            // transaction, so a recovery that lost the child's fence never leaves a receipt naming a child
            // whose adoption was refused. Through the VERB still — `adopt` writes `succeeded` under the
            // child's epoch AND the parent's driver (arch-review 34 P0), re-read inside the transaction so
            // the fence is proven against the row the commit actually lands on. A commit that THROWS
            // leaves the case active — the resume below re-dispatches it, which is the recoverable reading
            // of a store fault.
            const recoveryRuns = this.deps.runStore;
            const adoption = this.deps.caseReceipts
              ? await this.deps.caseReceipts
                  .commitCase(
                    this.commit.receiptOf(id, adoptedResult, {
                      childId: c.id,
                      // An adoption is THIS batch's execution, harvested by recovery — the case ran here
                      // (its dispatch just outlived the driver), so the kind is the run's own outcome.
                      kind: adoptedResult.failure !== undefined ? "failed" : "executed",
                      ...(c.executionId ? { executionId: c.executionId } : {}),
                      judges: judges,
                      ...(input.sealedJudges ? { sealedJudges: input.sealedJudges } : {}),
                    }),
                    async (runs) => {
                      const cur = await runs.get(c.id);
                      if (!cur || Run.from(cur).isTerminal()) return undefined;
                      return settleRun(runs, c.id, Run.from(cur).adopt(adoptedResult, this.now()).patch, undefined, {
                        epoch: cur.ownerEpoch ?? 0,
                        ...(parentDriver ? { parentDriver } : {}),
                      });
                    },
                    recoveryRuns,
                  )
                  .catch(() => undefined)
              : undefined;
            if (adoption === undefined) continue; // store fault — left active: the resume below re-dispatches it
            if (adoption.kind === "committed") {
              adopted += 1;
              seed.push(adoptedResult);
              seedRunIds.push(c.id);
              continue;
            }
            // Another attempt owns this case — the recovery does not adopt it.
            if (adoption.kind === "already_committed" && adoption.receipt.childRunId !== c.id) continue;
            // `unsettled` (the child settled on its own between the list and this write — the fence
            // refused, and the claim rolled back with it) or the idempotent re-claim of this very child:
            // the persisted truth decides — re-read the child and follow it.
            const settled = await this.deps.runStore.get(c.id);
            // It finished while we were harvesting: its own result is the evidence, not ours.
            if (settled?.result) {
              seed.push(settled.result);
              seedRunIds.push(c.id);
              continue;
            }
            // TERMINAL WITH NO RESULT IS UNFINISHED WORK, and this is the policy rather than an accident
            // (arch-review 29 P1). A child can settle `failed` carrying nothing — a dispatch that never
            // produced a case result, which is an infrastructure failure and exactly what a resume exists
            // to recover. Seeding nothing leaves the case in `casesToRun`, so it is re-dispatched.
            //
            // The alternative reading — "settled is settled, never re-run it" — would turn every lost
            // sandbox into a permanently unmeasured case, which is the outcome the retry vocabulary was
            // built to avoid. Saying which of the two this is beats leaving it to whichever branch runs.
            continue;
          }
          const interrupted = await settleRun(
            this.deps.runStore,
            c.id,
            Run.from(c).fail(
              { code: "INTERRUPTED", message: "Interrupted by a control-plane restart — re-dispatched on resume." },
              this.now(),
            ).patch,
            undefined,
            // …under the child's own epoch AND the parent's driver: one refuses a child somebody claimed
            // directly, the other refuses a recovery that has lost the batch it is recovering.
            { epoch: c.ownerEpoch ?? 0, ...(parentDriver ? { parentDriver } : {}) },
          );
          if (interrupted === undefined) {
            // The child settled between the read and this write. Marking it INTERRUPTED lost, correctly —
            // and treating it as remaining work would re-run a case that already has an answer, so the
            // persisted answer is seeded instead. A terminal child with no result falls through to the
            // re-dispatch for the reason above: nothing settled means nothing to carry.
            const settled = await this.deps.runStore.get(c.id);
            if (settled?.result) {
              seed.push(settled.result);
              seedRunIds.push(c.id);
            }
          }
        }
      }
      // Only seed cases that are still in the selection (dataset edits between runs shrink, never corrupt).
      const selected = new Set(dataset.cases.map((c) => c.id));
      const keep = seed.map((r, i) => [r, seedRunIds[i]] as const).filter(([r]) => selected.has(r.caseId));
      seed = keep.map(([r]) => r);
      seedRunIds.length = 0;
      seedRunIds.push(...keep.map(([, rid]) => rid).filter((x): x is string => x !== undefined));
    }
    return { seed, seedRunIds, adopted };
  }

  // …and the same question with no adoption to do: which cases a rebuilt batch context already considers
  // finished. The Temporal plan asks it per re-attach, so a re-planned batch never re-runs an answered case.
  // Returns encoded (case, trial) keys — `childKey`, the same spelling `canonicalChildPerCase` already keys
  // its map by (arch-review 52, wave 1). It used to fold that map's values back down to bare case ids, which
  // is why the Temporal driver could not carry a trialled batch: N trials of one case collapsed to one
  // "done", so the plan dropped the N−1 that had never run.
  async doneCaseKeys(id: string, tenant: string): Promise<Set<string>> {
    const doneKeys = new Set<string>();
    if (this.deps.runStore) {
      const children = await this.deps.runStore.list(tenant, { scorecardId: id });
      // …and the same rule decides what a rebuilt context already considers done (review 39, Phase 4): a
      // case is done when a receipt says which attempt answered it, never when a row happens to be newest.
      // No `.catch(() => [])` — an unreadable ledger fails the context build (retried), it does not read as
      // "nothing is done" (review 40 P0).
      const committedReceipts = (await this.deps.caseReceipts?.list(id)) ?? [];
      const canonical = ScorecardBatch.canonicalChildPerCase(children, committedReceipts);
      for (const [key, c] of canonical) if (c.status === "succeeded" && c.result) doneKeys.add(key);
    }
    return doneKeys;
  }
}
