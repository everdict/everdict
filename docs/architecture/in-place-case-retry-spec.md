---
kind: spec
title: "In-place case retry — a scorecard remembers that a case ran more than once"
status: landed
updated: 2026-09-04
anchors: [packages/contracts/src/records/scorecard.ts, packages/domain/src/scorecard/execution-revision.ts, packages/application-control/src/scorecard/retry-failed-batch.ts]
---
# In-place case retry — a scorecard remembers that a case ran more than once

> **Status: landed.** Every slice below is built. The counterexample each one owed is named with it, because
> a retry path that cannot be shown to refuse is a rewrite of history with a nicer name.

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

## Slice 2 — the pass: retry selected cases in place — **Landed**

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

**The whole sequence is Landed** as `RetryCasesInPlace` (`ScorecardService.retryCases`). The plan rebuild is `rebuildSealedPlan`
(`packages/application-control/src/scorecard/sealed-plan-rebuild.ts`) restores all five facets, and
`RetryFailedBatch` was rewired onto it rather than keeping a second copy — a five-facet restoration written
twice has already diverged (protocol L3), and the half that rots is the one whose author was thinking about
something else. Its 21 behaviour tests pass unchanged.

**The dispatch is `WorkflowBatchDriver.runBatchCase`**, which already runs exactly one (case, trial) of a
batch. It opens with two short-circuits an in-place retry must pass through:

    if (current && ScorecardBatch.from(current).isTerminal()) return { settled: true, skipped: true };
    if (ctx.doneKeys.has(workKey))                            return { settled: true, skipped: true };

Both are correct for what they guard and both describe the retry's ordinary case. They now take
`authority?: ExecutionPassAuthority` — absent (every ordinary dispatch, every Temporal activity, every
recovery) the method is exactly what it was; present and naming THIS record, it walks them and threads the
same authority to the commit. `doneKeys` is built from the receipt ledger, which is the ledger the commit
supersedes under that same authority, so the guard and the ledger stay one decision.

**Counterexamples, all Landed.** An empty case list claims no pass. Another workspace's scorecard is 404 —
the same answer the read gives. A running batch is refused. A case the batch never sealed is refused, and
nothing is dispatched. A decided case with no `reason` is refused, and nothing is dispatched — a refusal is
worth nothing if the compute was already spent. The same retry WITH a reason records it on the revision. An
infra death needs none. A second retry while one is live is refused. A case that throws leaves the marker
`failed` rather than cleared: a dead pass is addressable, a cleared one is indistinguishable from a pass that
never ran. And the marker is cleared in the SAME write that appends the revision — the revision boundary.

## Slice 3 — the ledger's neighbours: receipts, child runs, storage — **storage Landed**

The three readers that already exist and do not yet know about attempts, each an open question this slice
answers rather than assumes:

- **`CaseCommitReceipt` — DECIDED and Landed, and it is the hinge of the whole feature.** The table's key is
  `(scorecard_id, case_id, trial)`, the store is deliberately not CRUD (*"there is no update and no delete.
  A receipt is the record of a decision, and a decision that can be edited is not one"*), and
  `resultsFromLedger` makes the receipt AUTHORITATIVE for the settled plane: it rebuilds `results` from
  `receipt.childRunId` and drops anything the receipt does not vouch for. So a retried result that produces
  no receipt is not merely unrecorded — it is *dropped at the next settle*, and the batch silently keeps the
  answer the retry was repairing.

  Two ways out, and the narrow one wins:

  **Extend the receipt's key with an attempt ordinal.** Honest, and enormous: 20 modules read receipts and
  `childKey` is spelled at ~40 sites. Worse, canonicity would then have to be derived — and "the latest row
  is the winner" is the exact re-derivation protocol L3 bans.

  **Keep one receipt per (case, trial) as the CURRENT decision, and preserve the displaced one verbatim on
  the attempt ledger** (`CaseAttempt.receipt`). This is the monotonic projection the record already uses for
  `current` everywhere else: the old decision is not edited and not lost — it moves, whole, to an append-only
  ledger, and the authority that moved it is named (`executions[]` says which pass, when, by whom, why). The
  receipt store gains ONE superseding arm, gated on a live execution pass whose `targetRevision` is ahead of
  the record's last completed one; without that authority `commitCase` behaves exactly as it does today.

  What this preserves is the sentence the store was built around. "A decision that can be edited is not one"
  stays true: nothing edits a receipt. What changes is that a *new* decision may replace the pointer, under a
  named authority, with the old one kept — which is a different act, and the one this feature is about.

  **Landed**: `ExecutionPassAuthority` (a module-private branded value minted only by
  `executionPassAuthority`, which takes the record the CLAIM RETURNED and refuses unless its live marker is
  the pass being claimed for), the `superseded` outcome carrying the displaced receipt, and both stores.
  Nine counterexamples: the mint refuses a record with no marker, a marker naming a rival pass, and a marker
  that is no longer running; a commit with no authority leaves the pointer where it was; an authority for
  another record is refused; an authority on a never-committed case is an ordinary commit, not a
  supersession; and a REFUSED settle moves nothing.

  ⚠️ **The engine taught this one, and a text test could not have.** The first superseding statement read the
  row it was about to replace with `SELECT … FOR UPDATE` inside a CTE of the same statement — the obvious way
  to make a read-then-replace safe. Against a real Postgres that CTE came back EMPTY every time: a row being
  updated by the same statement cannot be locked by that statement's own CTE, so the lock became a skip. The
  upsert still moved the pointer, so the outcome read `committed` with no displaced receipt and the caller
  had nothing to preserve — the supersession degrading into precisely the silent edit this design refuses,
  green either way on a fake client. `prior AS MATERIALIZED`, no lock, and what the lock was for is handled
  upstream by the pass CAS, which admits exactly one pass per record.

  **Still owed**: `resultsFromLedger` rebuilding a retried plane from the NEW receipt — the assertion that
  proves the whole path end to end, and it needs the dispatch to exist first.
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

## Slice 4 — the doors — **Landed**

`POST /scorecards/:id/retry-cases` (body: `cases[]`, `reason?`; gate `scorecards:run`; 404 for another
workspace, the same answer the read gives) and the MCP twin `retry_scorecard_cases` — BFF↔MCP parity is
structural, and an operation an agent cannot drive is one no agent loop can converge. The forking `/retry`
stays, and both its route description and its MCP tool now say what it is and name its sibling.

## Slice 5 — the surfaces — **Landed**

The case row shows its attempt count (`ran 2×`), derived from the ledger rather than read from a stored
number — two counters of one fact diverge eventually. `RetryCaseButton` re-runs one case and asks for a
reason first when the case already reached a verdict, while the control plane refuses without one rather
than trusting the component to have asked. The web decodes only what it renders: `caseAttempts` is typed
there WITHOUT the displaced result, because a schema that decoded one would put a second trace behind every
case row.

**Still owed here**: opening a superseded attempt's trace. The bytes are on the record; nothing reads them
yet.

## What this does NOT do

- **It does not make a retried scorecard comparable to its old self.** A gate that pinned
  `{revision, scorePlaneDigest}` sees divergence, which is correct and is the point; teaching diffs to follow
  execution revisions is a separate decision.
- **It does not retry a case that is still running.** Terminal batches only, as `rescore-unmeasured` does.
- **It does not change what `trials` means.** A retry replaces an attempt of one (case, trial); it never adds
  a trial.
