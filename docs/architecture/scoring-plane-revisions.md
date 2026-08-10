# The scoring plane as revisions (MVCC)

> **Status:** DESIGN — arch-review 8 P2. The ownership work (P0, `fc6e4a19`) made concurrent scoring SAFE;
> this makes it SIMPLE. Nothing here is a fix: it removes the machinery the fix needed.
> Prerequisite reading: `docs/architecture/trust-certification.md` (the scoring revision ledger).

## Why this is P2 and not P0

The review that asked for fencing also asked for this, and was right to rank them in that order — but the
reason is worth stating precisely, because "we already fenced it" is not by itself an argument for stopping.

Fencing answers *who may write*. Revisions answer *where they write*. With fencing landed and certified
against real Postgres (`packages/db/src/results/scoring-pass-ownership.scenario.test.ts`), a superseded pass
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
3. **Contract** — `scoreCase` stops writing carriers; `finalizeScore` promotes. The strip step is deleted,
   and with it the reason `prepareScore` exists at all.

Each step ships alone. Step 3 is the one that changes behavior, and its precondition is code rather than
prose — `stagePromotionSafe(parity)`:

```
expectedJudged === staged && staged === matched
  && missingFromStage = [] && mismatched = [] && orphaned = []
```

`staged === matched` alone is **not** the precondition: it holds trivially when nothing was staged, which is
exactly the failure being guarded against. `orphaned` is separate from a value mismatch because it is the
shape where a promotion would *invent* a row rather than write a different one.

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
- **Embed groups.** They have no child rows; the stage promotes into the embedded scorecard. Same shape,
  simpler — worth confirming it does not want its own path.
- **Does `prepareScore` survive at all?** If the predicate reads the stage, the strip has no job. Deleting an
  activity is the clearest evidence this change paid for itself; keeping a vestigial one would be the opposite.
