---
kind: spec
title: "In-place case retry — a scorecard remembers that a case ran more than once"
status: proposed
updated: 2026-09-04
anchors: [packages/contracts/src/records/scorecard.ts, packages/domain/src/scorecard/execution-revision.ts, packages/application-control/src/scorecard/retry-failed-batch.ts]
---
# In-place case retry — a scorecard remembers that a case ran more than once

> **Status: proposed.** Nothing below is implemented unless a section says **Landed**. Each slice names the
> counterexample that has to be RED before it lands, because a retry path that cannot be shown to refuse is
> a rewrite of history with a nicer name.

## The gap, stated

`POST /scorecards/:id/retry` forks. Its own route comment says so: *"a NEW scorecard that re-runs only the
failed cases of a terminal batch; passing results are carried over verbatim and `origin.retryOf` keeps the
lineage (the source record is never mutated)."*

So a case that died on infrastructure — a runner that lost capacity, an image pull that 401'd, a judge whose
provider rate-limited — leaves a scorecard that is permanently wrong, and the only repair is a second record.
That costs three things:

- **The evidence splits.** One experiment now has two ids. `diffScorecards`, `trendSeries`, `leaderboard` and
  every gate join on a record id; none of them follows `retryOf`.
- **The original stays wrong forever.** A reader who arrives at it sees a failure that was repaired somewhere
  else, with no way to learn that from the record in front of them.
- **Nobody can ask how many times a case ran.** Which is the question that separates "this harness fails this
  task" from "our infrastructure was flaky on Tuesday", and it is the question this whole page exists for.

The judgment axis already solved its half of this: `POST /scorecards/:id/rescore-unmeasured` re-runs judges
**in place**, under the batch's own sealed pins, and keeps identity in the append-only `scoring[]` ledger with
an in-flight `scoringPass` holding the lease. Execution had no equivalent. This spec is that equivalent.

## The model

Three fields, mirroring the three the judgment axis already has:

    scorecard.results[]   the CURRENT attempt per (caseId, trial) — unchanged shape, unchanged readers.
                          A monotonic projection (protocol L4): the newest attempt is the case's answer.
    caseAttempts[]        the append-only ledger of SUPERSEDED attempts, each with its whole CaseResult.
                          Evidence is never destroyed by a retry; it is moved off the current plane.
    executions[]          the revision ledger — which pass replaced which attempts, when, by whom, and why.
    executionPass         the in-flight lease, written and read back BEFORE any dispatch (protocol L1).

**Semantics, decided:** the newest attempt is the case's answer and every earlier one is kept and counted.
The alternative — appending a retry as a new `trial` — was rejected: `trial` is the *planned replication*
axis that `diffTrials` runs Fisher's exact test over, so a retried 3-trial case would silently become a
4-trial case and an infrastructure death would enter the sample as an observation of the harness.

### Why the attempt ordinal is NOT on `CaseResult`

arch-review 66 established that platform lifecycle state on the measurement document is a defect, and its
first consequence is fatal here: `caseResultDigest` and `caseObservationDigest` cover that document, and the
receipt ledger, the judgment-input comparison (`inputObservation`) and `experimentIdentity` all join on those
digests. Stamping an attempt number onto the result would make the **same agent bytes digest differently**
depending on how many times the platform had to ask.

So `CaseResult` keeps answering only *what did the agent do*, and the ordinal lives on the ledger the platform
writes. This also keeps the field off `UntrustedCaseResultSchema`'s problem surface entirely — there is no new
producer-forgeable coordinate.

### A retry that launders a verdict is permitted, and never silent

The motivating case is an infrastructure death, where the replaced attempt measured nothing and the only
honest reading of the batch is the one where the case ran. `unmeasured` and `cancelled` are the same shape.

A case that **completed** is different, and re-running a genuine FAIL until it passes is a real thing people
will do for real reasons. Refusing it outright pushes them back to forking a whole scorecard, which records
strictly less. So it is allowed and the pass must say why: `reason` is required exactly there
(`retryReasonRequired` / `keysRequiringReason`), and it lands on the revision where a reader meets it.

The predicate is about the OUTCOME, not about pass/fail: laundering a PASS into a fail deserves the same
sentence as the other direction.

## Slice 1 — the axis: contracts + the pure decisions — **Landed**

`CaseAttemptSchema` · `ExecutionRevisionSchema` · `ExecutionPassSchema` · `ScorecardRetrySummarySchema`, wired
onto `ScorecardRecordSchema`; `packages/domain/src/scorecard/execution-revision.ts` holds the pure answers:
`attemptsForCase` · `attemptCounts` · `retrySummaryOf` · `nextExecutionRevision` · `retryReasonRequired` ·
`keysRequiringReason` · `supersedeAttempts`.

Six invariants, each driven RED by neutralizing it in the production file and restored:

| invariant | neutralization that must go red |
|---|---|
| the composite key is escaped | `caseId` / `` `${caseId}#${trial}` `` — collides `("c#1")` with `("c", 1)` |
| a revision number is the MAX + 1 | `executions.length + 1` — re-issues a number a gate already pinned |
| a reason is owed in BOTH verdict directions | guard only the FAIL direction |
| the new attempt is numbered from the ledger | a constant `1` |
| a retry may not ADD a case to a sealed batch | append the orphan to the plane |
| a pass that produced nothing may not EMPTY a case | filter the plane to what came back |

## Slice 2 — the pass: retry selected cases in place

`ScorecardService.retryCases({tenant, id, cases[], reason?})`, and the sequence is the protocol:

1. read the record; an unreadable store is `unknown` and REFUSES — it is never "no attempts";
2. refuse a batch that is not terminal, a key the batch never sealed, and a decided case with no `reason`;
3. write `executionPass` and **read it back** — the proof that names the effect is durable before any case is
   dispatched, and a second concurrent retry is refused against it;
4. re-run the selected cases under the batch's **own sealed plan** — the source dataset documents, the
   recorded grading plan, the sealed environments at their pinned versions, the harness closure with its
   pins. A retry that re-resolved `latest` would measure a different world under an unchanged manifest;
5. re-judge exactly those cases under the batch's own judge pins, the way `rescoreUnmeasured` already does;
6. settle in ONE guarded write: supersede → append the revision → recompute `summary` / `verdictSummary` /
   `trialSummary` / `retrySummary` → clear the pass.

**Step 3 is Landed** (see slice 3). **Step 4's plan rebuild is Landed**: `rebuildSealedPlan`
(`packages/application-control/src/scorecard/sealed-plan-rebuild.ts`) restores all five facets, and
`RetryFailedBatch` was rewired onto it rather than keeping a second copy — a five-facet restoration written
twice has already diverged (protocol L3), and the half that rots is the one whose author was thinking about
something else. Its 21 behaviour tests pass unchanged.

**What is NOT yet landed is the dispatch itself, and reading the existing path says why it is its own slice.**
`WorkflowBatchDriver.runBatchCase` — the natural reuse, since it already runs exactly one (case, trial) of a
batch — opens with two short-circuits an in-place retry must pass through:

    if (current && ScorecardBatch.from(current).isTerminal()) return { settled: true, skipped: true };
    if (ctx.doneKeys.has(workKey))                            return { settled: true, skipped: true };

Both are correct for what they guard (a terminal batch takes no more work; a committed case is not re-run)
and both describe the retry's ordinary case. `doneKeys` is built from the receipt ledger, which is the same
place slice 3's receipt question lives — so loosening these is not a flag, it is the design of how a pass
authorizes work on a settled record. It is written where the receipt identity is decided, or the guard and
the ledger will disagree.

**Counterexamples owed.** A retry with no `reason` on a completed case is refused. A retry naming a case the
batch never sealed is refused. Two concurrent retries: the second is refused, not merged — *this one is
Landed, driven against a real Postgres and against the twin.* A crash between step 3 and step 6 leaves a
readable pass and no half-moved plane. A settle whose guarded write loses the CAS supersedes nothing.

## Slice 3 — the ledger's neighbours: receipts, child runs, storage — **storage Landed**

The three readers that already exist and do not yet know about attempts, each an open question this slice
answers rather than assumes:

- **`CaseCommitReceipt`** is keyed by the case, and a second attempt commits a second outcome for one key.
  Either the receipt carries the attempt, or the retry's commit is refused by the ledger it must pass.
- **Child runs.** Each case has an addressable child `RunRecord`; a retry makes another. The superseded
  attempt's child must stay readable, so `runIds` grows rather than being replaced.
- **Storage — Landed.** Migration `0213` adds `executions` / `case_attempts` / `execution_pass` /
  `retry_summary`. `caseAttempts` is heavy (whole results, traces included) and is gated on `hasDetail`
  exactly like `scorecard`; the other three ride the list projection for the reason `scoring_pass` does — a
  reader deciding whether a plane is mid-repair must SEE the live pass to refuse it. The claim guards
  (`expectExecutionPassId` / `expectExecutionPassReclaimable` / `stampExecutionLeaseSeconds`) are spelled as
  the scoring pair, deliberately: this protocol was paid for twice already (arch-review 8's read-check-write
  was not a lock; arch-review 10's lease was minted by one clock and judged by another), and a cleverer
  second spelling would be the divergence.

  Certified against a real Postgres 16, because a fake client that asserts on SQL TEXT answers happily to a
  statement no planner accepts: a fresh claim wins and the DATABASE mints the lease, a rival fresh claim is
  refused, the owner writes, a stranger is refused.

## Slice 4 — the doors

`POST /scorecards/:id/retry-cases` (body: `cases[]`, `reason?`; gate `scorecards:run`; 404 for another
workspace, the same answer the read gives) and the MCP twin — BFF↔MCP parity is structural, and an operation
an agent cannot drive is one no agent loop can converge. The existing forking `/retry` stays, renamed in its
own documentation as what it is: a fork, for when you want a separate experiment.

## Slice 5 — the surfaces

The case row shows its attempt count and lets a reader open a superseded attempt's trace; the scorecard shows
`retrySummary`. Without this the ledger is a field nobody reads, which is the defect the whole record system
is built to refuse.

## What this does NOT do

- **It does not make a retried scorecard comparable to its old self.** A gate that pinned
  `{revision, scorePlaneDigest}` sees divergence, which is correct and is the point; teaching diffs to follow
  execution revisions is a separate decision.
- **It does not retry a case that is still running.** Terminal batches only, as `rescore-unmeasured` does.
- **It does not change what `trials` means.** A retry replaces an attempt of one (case, trial); it never adds
  a trial.
