---
kind: wiki
title: "The scoring plane as revisions (MVCC)"
status: current
updated: 2026-08-15
anchors: [apps/api/src/trust/pass-ownership.trust.test.ts, packages/db/src/results/scoring-stage-round-trip.scenario.test.ts]
---
# The scoring plane as revisions (MVCC)

> **Status:** DESIGN — arch-review 8 P2. The ownership work (P0, `fc6e4a19`) made concurrent scoring SAFE;
> this makes it SIMPLE. Nothing here is a fix: it removes the machinery the fix needed.
> Prerequisite reading: `docs/trust-certification.md` (the scoring revision ledger).

## Why this is P2 and not P0

The review that asked for fencing also asked for this, and was right to rank them in that order — but the
reason is worth stating precisely, because "we already fenced it" is not by itself an argument for stopping.

Fencing answers *who may write*. Revisions answer *where they write*. With fencing landed and certified
against real Postgres (`apps/api/src/trust/pass-ownership.trust.test.ts`), a superseded pass
cannot mutate the plane — so the remaining problem is not correctness, it is that **reader and writer share
one mutable structure**, and every guarantee about that structure has to be defended by a guard:

| Guard | Exists because reader and writer share `child.result.scores` |
| --- | --- |
| `scoringPass` marker | the plane is mid-rewrite and must not be read |
| `prepareScore` strip-first | the plane still holds the previous pass's judgments |
| child-write fence | a superseded writer could still reach the live plane |
| pass-keyed artifacts | two passes freeze bundles for one revision number |
| settle CAS (ledger + epoch) | two passes could both append revision N+1 |

Every row is a consequence of the same shape. Separate the planes and the whole column becomes unnecessary —
a stale writer writes into a plane nobody points at, which is not a hazard, just garbage.

## The shape

```
revision N   ← readers (immutable, complete)
                   │
                   │  a pass claims → writes into its OWN plane
                   ▼
staging (passId)   judgments accumulate here, visible to nobody
                   │
                   │  finalize: append revision N+1 + switch pointer  (one CAS)
                   ▼
revision N+1 ← readers
```

The pointer switch already exists — the scoring ledger's guarded append IS the switch. What changes is where
the judgments live before it.

## Where the scores actually live today (the cost driver)

This is the part that makes the change non-trivial, and the reason it is scheduled rather than folded into
the ownership work:

- **Dedup groups** keep scores on the CHILD RUN rows (`everdict_runs.result.scores`), hydrated into the
  scorecard on read. Those same rows are the runs a member browses — a run's scores are a user-visible
  surface, not an internal projection.
- **Embed groups** keep them inside `everdict_scorecards.scorecard`.

So "move the plane" is not one table's problem. A staging plane has to be introduced without either
(a) taking scores off the run record, or (b) leaving two sources of truth.

## The design that avoids both

**Write-ahead, then promote.** Judgments are staged per pass; the finalize promotes them onto the existing
carriers in the same transaction as the ledger append.

```sql
CREATE TABLE everdict_scoring_stage (
  scorecard_id text NOT NULL,
  pass_id      text NOT NULL,
  case_key     text NOT NULL,   -- caseId#trial
  judge_id     text NOT NULL,   -- mig 0153 — the unit that independently retries and goes terminal
  scores       jsonb NOT NULL,
  written_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scorecard_id, pass_id, case_key, judge_id)
);
```

**The row's unit is the JUDGE** (mig 0153). Everything else about a judgment already is: `JudgeProgress`, the
attempt budget, metric-family ownership, and — since the retry was narrowed — the mutation itself. A per-case
key was the persistence layer disagreeing with the unit the domain mutates, which is the same mismatch this
generation of review kept finding one layer up. It also could not express what the contract step needs:
first-writer-wins would arbitrate a whole case (colliding two attempts that judged *different* judges), a
promotion could not say which judge in a row a given pass produced, and a per-judge attempt CAS would have
nowhere to live. Re-keyed during the expand phase deliberately — nothing reads the stage to decide anything,
so the change is free now and a reshape of authoritative data later.

**The stage's two authorities are different things, and only one is still shadow.** After the claim work the
same table answers two questions, and conflating them is how a fail-open survived a round:

```
Stage DATA authority         still SHADOW — carriers remain the source of truth until the contract step
Stage WRITE-CLAIM authority  already PRODUCTION — it decides which invocation may write at all
```

While it was purely shadow, swallowing a stage failure and writing anyway was the rollback-safe choice. It
stopped being that the moment it became the arbiter: an arbiter that cannot answer must never be read as "you
won", or the race it settles is restored at exactly the moment it is least observable. The claim call is
therefore fail-closed — the activity fails, Temporal retries, the carrier is untouched.

**The claim spans the PASS, not one activity execution.** The first version used Temporal's `attempt` alone,
reasoning that it is monotonic. It is — per ACTIVITY EXECUTION, while a stage row lives for the whole pass.
After a continue-as-new the workflow re-plans and schedules the still-pending case as a NEW execution starting
at attempt 1, so a legitimate fresh judgment was refused by a number the previous execution left behind and
the case could never finish. The claim is the pair `(generation, attempt)`: `generation` is the workflow's
rotation ordinal, carried in its INPUT so it stays deterministic. An authority token has to have exactly the
scope and lifetime of the mutation it governs.

**The stage ARBITRATES; the carrier follows** (arch-review 14 §11, mig 0158). The pass marker decides who may
write a group's plane and decides it correctly — and it cannot decide between two writes of the SAME pass.
Temporal produces exactly that: an activity whose attempt timed out while its provider call kept running,
plus the replacement. Both hold the same passId, both clear every guard. The stage was first-writer-wins and
the carrier last-writer-wins, so the two disagreed by construction, the revision took the carrier's answer,
and parity noticed afterwards — a report is not an arbitration.

A pass's authority also ENDS (arch-review 17 P0-3). `failScore` flips a terminally-failed pass's marker, and
that is a capability revocation rather than a note: every fence — the settle CAS, the child-write EXISTS, the
service's own `owningPass` — requires `status = 'running'` as well as the passId, so a late activity of a dead
pass cannot land its judgment and a late finalize cannot append a revision over a plane whose owner was
already declared abandoned. Identity answers "who is this"; status answers "may it still act". A takeover is
the one caller that declares it is claiming a dead marker (`expectScoringPassReclaimable`), and it still can.

The claim's pass-global half is the **logical round** ordinal, not the workflow's rotation count
(arch-review 16 P0-1). Scoping it to rotations was right while rotation was the only thing that produced a new
activity execution; the plan→execute→replan loop made every ROUND produce one, and Temporal's `attempt`
restarts at 1 in each — so a round's first attempt lost to the previous round's exhausted ones and the case
could never finish. The ordinal advances on every new mutation opportunity; rotation merely carries it.

Neither rule was right on its own. "First wins" hands the record to an attempt the orchestrator has already
superseded; "last wins" is the mirror. The question was never first-or-last but WHICH ATTEMPT HOLDS THE RIGHT
TO WRITE, and Temporal already answers it: `attempt` is monotonic per activity execution, so the highest
attempt is the current one. `stage()` is therefore a CLAIM that returns what it accepted, and the carrier
write proceeds only for those — one decider, one follower, one winner.

And it follows PER JUDGE. The first version collapsed the claim's per-(case, judge) answer back into a
case-level boolean, so one accepted judge let the whole case plane through and a REJECTED judge's bytes rode
along on its neighbour's win — deciding in one unit and mutating in another, reintroduced by the fix for it.
The write strips and replaces only the accepted families, onto the child's CURRENT scores.

**A staged row means "THIS PASS JUDGED THIS CASE" — nothing else.** The alternative reading (*the full
desired score plane*) is the one the expand step accidentally shipped: `prepareScore`'s strip also went
through the write-back, so a row appeared the moment a pass *touched* a case, judged or not. `stage row
exists → this case is done` is the obvious way to write the promotion, it would have been silently wrong on
every case the strip cleared and the pass never reached, and the bug would have looked like a scoring bug
rather than a semantics one (arch-review 10 P1). The strip no longer stages.

**And a staged row holds THIS PASS'S JUDGMENTS ONLY — a true delta** (arch-review 11). The port said delta
and the code staged the whole resulting case plane, inherited graders and other judges included. Two costs:
the promotion could not tell what a pass *produced* from what it merely carried along, and a stage holding
inherited rows quietly becomes a full-plane snapshot whose correctness depends on the pass having read those
rows at exactly the right moment. Staged as a delta, the merge is explicit — inherited evidence stays on the
carrier, produced evidence comes from the stage — which is the distinction the promotion has to make anyway.

- `scoreCase` writes here (keyed by its own pass) instead of onto the child row.
- `planScore`'s "already judged in THIS pass" predicate reads the stage — which is what the id-only predicate
  was always trying to approximate, so the strip-first step **disappears entirely**.
- `finalizeScore` promotes stage → carriers and appends the revision in one statement. A loser's rows are
  never promoted; a cleanup sweep drops stage rows for settled/abandoned passes.

What this buys beyond simplicity: **the live plane is never half-written**. Today a pass strips first, so a
crash leaves the record advertising judgments that no longer exist — which is why a failed marker has to keep
readers out. With staging there is no in-between state to guard, so `scoringPass` narrows from "the plane is
unreadable" to what it should have been all along: a lease saying who may promote next.

## Migration (expand → deploy → contract, per the db rules)

1. **Expand** — add the table (mig 0149). Writers dual-write (stage + carrier) so a rollback loses nothing.
2. **Deploy** — readers unchanged (carriers are still the truth). The stage is **observed**, and observed
   means *measured*: every settled pass compares its stage against the plane it wrote and reports
   `everdict_scoring_stage_parity_total{result=matched|mismatched|orphaned|missing_from_stage}`
   (`ScoringStageParity`). A week of dual-writing that nobody compared is not evidence that the two agree — it
   is evidence that both writes happened, which was never in doubt (arch-review 10 P1). The comparison runs
   strictly after the settle and is strictly non-fatal: a measurement must never be able to fail the thing it
   measures.

   **The report has to be able to say NO.** Its first version walked the *staged rows* and compared each to
   the plane, so a pass that judged 100 cases and failed to stage 20 reported 80 staged / 80 matched / 0
   mismatched — a perfect parity score describing a 20% loss (arch-review 11). A measurement that can only see
   what it wrote cannot detect that something was not written, and the stage write is best-effort by design.
   `expectedJudged` is therefore derived from the **settled plane**: a pass strips the selected judges' rows
   before it starts, so any selected-judge row on the settled plane was produced by this pass — that set is
   "what this pass judged", independent of whether the stage write survived. `missingFromStage` is the
   difference, and it is the dimension the contract step actually depends on.

   **…and the observation is DURABLE, not a counter** (arch-review 16 P1-6). It rides the settled
   `ScoringRevision` (`stageParity`, written in the same guarded update as the revision), and the process
   metric is a projection of that. As a metric alone it could not be re-read per pass, and a control plane
   that died between the settle and the fire-and-forget callback left the pass with NO observation at all —
   silently indistinguishable, in the promotion's own input, from a pass that agreed. A promotion decision
   cannot rest on evidence that disappears exactly when the thing it observes crashes.

   **The comparison is canonical.** It compared `JSON.stringify` of two objects that had travelled different
   storage paths: the plane's rows come back through `ScoreSchema.parse` (declaration key order, defaults
   such as `status: "measured"` applied), the staged rows come back as raw jsonb (Postgres key order, no
   defaults). Byte-identical judgments compared UNEQUAL, so the series gating the promotion reported a
   mismatch for essentially every pass — worse than no measurement, because it is always wrong in the
   direction of "do not promote" and therefore never investigated. Both sides are parsed through the same
   schema, sorted by metric, and digested canonically.

   **Lifetime.** A pass's stage rows are cleared once its revision carries that durable observation, and when
   a pass is declared dead (`failScore` — it will never write again). Never before the observation, which is
   the evidence the promotion reads; never "eventually", since the rows are one per
   (scorecard × pass × case × judge). The cleanup is awaited though non-fatal: the ordering is an invariant,
   and an unawaited one is unobservable — nothing can assert it and a process exiting after the settle would
   leave the rows behind for no reason.

   **The gate itself is a function, not a sentence** (arch-review 22, final). "Promote once real-traffic
   parity is observed" is a precondition nobody could evaluate, and a migration whose gate cannot be
   evaluated is one that never happens — this one has been deferred by five consecutive reviews on exactly
   that wording. `stagePromotionReadiness(revisions, minimumObserved)` (domain) reads the durable
   observations and answers it: a revision with no `stageParity` counts as UNOBSERVED rather than as
   agreement, one incomplete comparison blocks whatever the others said, and a disagreeing pass is named so
   the decision is traceable to what stops it. `minimumObserved` stays the caller's — how much traffic is
   enough is a product judgement — but zero is refused, because a fleet that never staged anything agrees
   with itself perfectly. TRUST-124.

   **Forensics** (arch-review 17 P1-7). The revision also freezes WHICH units disagreed, bounded and labelled
   as a sample. The counts make the promotion decision; the ids make it diagnosable — and since the rows are
   collected immediately afterwards, a `promotionSafe: false` investigated later would otherwise know that N
   judgments disagreed with no way left to learn which.
3. **Rehearse the read side** — `EVERDICT_SCORING_STAGE_AUTHORITATIVE=1`, off by default (arch-review 43 ①).
   A settled pass builds the plane it certifies by PROMOTING its staged delta onto the carriers
   (`promoteStagedJudgments`) instead of taking the carriers as written.

   This exists because every observation up to here compares **data** — staged bytes against plane bytes —
   which certifies the dual write and says nothing about the **code** that would consume it. The merge is
   where the interesting mistakes live (inherited rows dropped, an unselected judge's family replaced, a
   trial keyed by case alone), and until this step it did not exist to be wrong. A week of green parity is
   not evidence about a function nobody has run.

   It cannot change a record, by construction: the promotion applies only where this pass's own parity
   observation says the two sources agree completely, and the promoted plane is re-digested against the
   carrier plane before it is used. Anything else is REFUSED — recorded on the revision as
   `stagePromotion: { applied: false, refusal }` and narrated as a step, never as a quiet fallback. A
   promotion whose merged plane moves the bytes over units the comparison called identical also voids the
   OBSERVATION (`completed: false`): a green `promotionSafe` beside a refused promotion would let the fleet
   gate be certified by the very report its own rehearsal contradicted.

   **Blocker cleared: embed-mode groups now stage** (arch-review 44 ①). The stage write used to live inside
   `writeBackScores`, which returns early when a group has no child runs — so an embed group's judgments were
   judged, carried on the embedded scorecard, and never staged. Parity reported it correctly
   (`missingFromStage` = everything, so the pass was not promotion-safe and the readiness gate blocked), and
   that correctness was the trap: the fleet gate could never go green while embed groups ran, and a contract
   step taken anyway would have dropped every embed group's judgments.

   The two writes answer different questions — *this pass judged this case* versus *here is where the bytes
   live* — and sharing one guard let the second decide the first. `stageJudgments` is now its own step, run
   before the carrier guard; the carrier write keeps its guard, because an embed group writes its plane
   through the settle's embedded `scorecard` patch rather than per case. The arbitration a staged claim
   returns is still what the carrier obeys, so nothing about the per-judge claim changed. Fail-closed now
   reaches embed groups too: an arbiter that cannot answer fails the pass instead of settling over a plane it
   never saw.

   **…and the comparison's BASIS is pinned rather than assumed** (arch-review 44 ②). Parity means *the stage
   agrees with the plane this pass WROTE*, and step 4's entire content is making the settled plane come from
   the stage instead. Write the comparison the obvious way at that point — against the plane being settled —
   and it becomes the stage against itself: perfect agreement, on every pass, forever, with the readiness gate
   reading it as evidence that the migration is safe. The only thing standing between the migration and that
   outcome was the ORDER of two statements inside `aggregate` and a comment asking the next reader not to move
   them. A migration whose safety rests on a comment is one nobody can take.

   So the observation states what it was taken against (`ScoringStageParity.basisDigest`) and the promotion
   checks it (`stagePromotionRefusal`'s second argument): a comparison whose basis is not the plane being
   promoted from is REFUSED by name, and so is one that pinned no basis at all — "we cannot tell what this
   was compared to" must never read as "the carriers". `promotionSafe` on the revision keeps its old meaning
   (the DATA agreed); the basis is the promotion's admission check, so a code-defect guard never rewrites what
   the observation recorded. `CURRENT_STAGE_PARITY_VERSION` is 2 accordingly — era 1's greens were gathered
   while the basis was a convention, and the readiness gate counts only its own era.

   Both are certified against a real database, not a fake: `packages/db/src/results/scoring-stage-round-trip.scenario.test.ts`
   (env-gated on `EVERDICT_E2E_DATABASE_URL`) drives one embed-group re-score through `PgScoringStageStore` +
   `PgScorecardStore` and asserts the staged bytes come back digest-identically through the jsonb column. It
   has to be a real column: a fake `SqlClient` returns the object it was handed and the InMemory twin returns
   the very array that was staged, so neither can disagree with itself — while the live paths differ by
   design (`ScoreSchema.parse` defaults and declaration key order on one side, raw jsonb on the other), which
   is the difference that made the comparison wrong for essentially every pass once before.

4. **Contract** — `scoreCase` stops writing carriers; `finalizeScore` promotes. The strip step is deleted,
   and with it the reason `prepareScore` exists at all.

Each step ships alone. Step 4 is the one that changes behavior, and its precondition is code rather than
prose — `stagePromotionSafe(parity)`:

```
expectedJudged === staged && staged === matched
  && missingFromStage = [] && mismatched = [] && orphaned = []
```

`staged === matched` alone is **not** the precondition: it holds trivially when nothing was staged, which is
exactly the failure being guarded against. `orphaned` is separate from a value mismatch because it is the
shape where a promotion would *invent* a row rather than write a different one.

Neither is any of it the precondition on its own, because every one of those numbers is a statement about
*some* plane. `basisDigest === scorePlaneDigest(the plane being promoted from)` is the clause that says
**which** — without it the counts above are perfect for free the moment step 4 lands, since the plane they
describe would be the one the stage produced (arch-review 44 ②).

## What this does NOT change

- The revision ledger, its digests, and the gate pins — unchanged. This moves where judgments accumulate,
  not what a revision means.
- The child run rows stay the scores' home. A run detail keeps showing its scores; nothing about the member
  surface moves.
- Ownership stays. A lease is still needed to decide who may promote — fencing the CARRIER write becomes
  unnecessary, the claim does not.

## Open questions

- **Stage lifetime.** An abandoned pass's rows are evidence of what it was doing (the same argument that kept
  the loser's analysis artifact). Sweep on a schedule, or keep them addressable as pass history?
- **Embed groups.** They have no child rows, so the stage promotes into the embedded scorecard. They now
  reach the stage write (arch-review 44 ①, see step 3), which is what makes them observable at all; what is
  still open is the contract-step shape — the settle already writes the whole embedded plane in one patch, so
  there is no per-case carrier for step 4 to stop writing, and "scoreCase stops writing carriers" has no
  embed-side counterpart to delete.
- **Does `prepareScore` survive at all?** If the predicate reads the stage, the strip has no job. Deleting an
  activity is the clearest evidence this change paid for itself; keeping a vestigial one would be the opposite.
