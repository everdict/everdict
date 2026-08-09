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
  scores       jsonb NOT NULL,
  written_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scorecard_id, pass_id, case_key)
);
```

**A staged row means "THIS PASS JUDGED THIS CASE" — nothing else.** The alternative reading (*the full
desired score plane*) is the one the expand step accidentally shipped: `prepareScore`'s strip also went
through the write-back, so a row appeared the moment a pass *touched* a case, judged or not. `stage row
exists → this case is done` is the obvious way to write the promotion, it would have been silently wrong on
every case the strip cleared and the pass never reached, and the bug would have looked like a scoring bug
rather than a semantics one (arch-review 10 P1). The strip no longer stages. The delta reading also keeps the
two provenances apart — what this pass produced vs what it inherited from the previous revision — which is a
distinction the promotion has to make anyway.

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
   `everdict_scoring_stage_parity_total{result=matched|mismatched|orphaned}` (`ScoringStageParity`). A week of
   dual-writing that nobody compared is not evidence that the two agree — it is evidence that both writes
   happened, which was never in doubt (arch-review 10 P1). The comparison runs strictly after the settle and
   is strictly non-fatal: a measurement must never be able to fail the thing it measures.
3. **Contract** — `scoreCase` stops writing carriers; `finalizeScore` promotes. The strip step is deleted,
   and with it the reason `prepareScore` exists at all.

Each step ships alone. Step 3 is the one that changes behavior, and its precondition is stated rather than
assumed: `mismatched` and `orphaned` at zero across real traffic. `orphaned` is called out separately from a
value mismatch because it is the shape where a promotion would *invent* a row rather than write a different
one.

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
