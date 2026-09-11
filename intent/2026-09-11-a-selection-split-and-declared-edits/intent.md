# Intent: a selection split and declared edits, so an optimizer loop can search without spending the exam

Author: maintainer (requested in conversation — "support SkillOpt's methodology in Everdict"). Status: draft

Design: owed — `pnpm design --next` picks this up when it is accepted. The platform/driver boundary below is
argued but not settled, and §"Open questions" is the design pass rather than leftovers from it.

## Problem

SkillOpt (arXiv 2605.23904v2) trains a skill document as the external state of a FROZEN agent. One step:
collect rollouts, partition them into success and failure minibatches, reflect on each separately, merge and
rank the proposed `add`/`delete`/`replace` edits, clip to the top `L_t` (a "textual learning rate"), apply,
evaluate the candidate on a **selection** split, and accept only if the selection score strictly improves.
Rejected edits and the score drop they caused go into an epoch-local buffer that later reflections read. At
epoch end a slow/meta update compares trajectories under the previous and current skill and writes a
longitudinal block into a PROTECTED region that step edits may not touch. All reported scores come from a
third, disjoint **test** split.

Everdict already holds four of those seven mechanisms, and holds three things SkillOpt's own limitations
section says it lacks — a positive control that refuses a dead instrument (`examProvenBy` / `examInertness`),
an adoption gate that is a significance test rather than "strictly greater", and a brief that excludes the
held-out set by construction and redacts it out of free text. Those are to be kept, not borrowed from.

What is missing is the part that lets an optimizer SEARCH.

### The measurement, because the argument rests on it and not on preference

A round is judged at `fdrAlpha / heldOutFamilySize`, with Benjamini–Hochberg across the round's cases, and
`heldOutFamilySize` must be at least `budget.maxRounds` because every round consults the held-out set. So
running a 20-step optimizer epoch as 20 rounds means a family of 20.

Computed with this repository's OWN `fisherExactTwoSided` and `benjaminiHochberg` (the functions the gate
calls), for one of ten held-out cases genuinely moving 0.20 → 0.60. The script is `power.mjs` beside this
file, so the table is re-derivable rather than quoted:

    trials/side      family=20 (today)    family=1 (one confirmation)
             20                  0.080                        0.315
             50                  0.620                        0.895
             75                  0.911                        0.988

Total case executions for one 20-step epoch at ≈0.8 power on the confirming comparison:

    today   every step confirms, n=75   →  20 × 10 × 2 × 75  =  30,000
    split   selection n=3 × 20 steps, then ONE confirmation n=50  =  2,200

⚠️ **An earlier version of this argument said the inner loop was arithmetically impossible under the current
gate. That was too strong and is corrected here.** It is possible; at family 20 and 75 trials a side the power
is 0.911. What it is, is **~13.6× more expensive for the same evidential standard**, because the family
correction scales with how many times the confirmation set is consulted, and consulting it once per candidate
ties the cost of SEARCHING to the cost of CLAIMING.

⚠️ One thing genuinely is impossible: at `family ≥ 10` the smallest two-sided Fisher p at n=5 (0.0079) exceeds
the threshold, so a five-trial round cannot clear it for ANY effect size. The repository's own comment records
the n=5 case; the table above is what it looks like across the grid.

⚠️ And the family size is not doing most of the work — the number of held-out CASES is. At family 1 with ten
held-out cases and one moving, BH still demands roughly `q/H`. A selection split buys the family factor, not
the case factor.

### The second gap: the proposer may not see any score

`round-brief.ts` excludes scores entirely, on the grounds that "a delegate that can see the number optimizes
the number, which is aiming at the exam by a different route". That reasoning is exactly right about the
EXAM. On the train split it is the job — the frame itself defines `targets` as "scenario ids the loop is
briefed on and optimizes against". SkillOpt's optimizer needs scored rollouts partitioned into success and
failure minibatches, because "single trajectories often produce anecdotal fixes, while minibatches expose
reusable procedural errors", and Everdict has that data per case (`RoundEvidenceCase.verdict`, `diagnoses`,
`attribution.slot`) with no path to a proposer.

### The third gap: a candidate is opaque bytes

There is no representation of WHAT changed. `L_t`, the rejected-edit buffer and the protected region are all
statements about edits, and Everdict has no edit.

## Proposed outcome

- An optimizer can run many candidate steps against a population that is not the confirmation population, and
  the confirmation set is consulted the number of times the campaign CLAIMS, not the number of times it
  SEARCHES.
- A proposer can see train-split evidence, including scores, and can see whether its last candidate was
  accepted — and cannot see any per-case selection or confirmation detail.
- A candidate carries a declared edit set, and a declared edit set that does not reproduce the candidate's
  registered bytes is refused.
- A region of the artifact can be declared off-limits to step edits, so a longitudinal consolidation is not
  overwritten by the next local fix.

## Affected users and systems

`packages/contracts` (the frame's scenario roles, the edit record, the receipt), `packages/domain`
(`campaignRoundBrief`, the gate's family accounting, the edit verifier as a pure function), 
`packages/application-control` (`CampaignService`'s round path and the selection ledger),
`packages/db` (the selection ledger's rows), `apps/api` (the doors a driver needs).
`docs/architecture/evolution-research-directions.md` C2 and C5 are the proposal this narrows;
`docs/architecture/evolution-literature-review.md` R38 is the source.

## Constraints

- **Three-tier disclosure, and the tiers are not symmetric.** train: everything, per case. selection: the
  accept/reject decision and an aggregate delta, never per-case, never a case id. confirmation: nothing — not
  ids, not counts, not the fact that it ran. The existing free-text redaction must cover selection ids too.
- **Selection uses a cheap deterministic rule; confirmation keeps the significance gate.** "Strictly greater"
  is right for RANKING candidates and would be a weakening if it ever decided an adoption. The asymmetry is
  why the split pays for itself.
- **`heldOut` and any new role field may not both be a source of truth.** One owner, and a legacy frame must
  keep decoding and keep meaning what it meant (the schema-split law).
- **The selection budget is declared and frozen like everything else the verdict depends on.**
  `budget.maxRounds` bounds rounds; nothing today bounds how many selection evaluations a driver may spend.
- **`heldOutFamilySize >= budget.maxRounds` has to become a statement about CONFIRMING rounds**, or the split
  buys nothing — and getting that wrong under-corrects the thing the field exists to correct.
- **A slow update is a new version, never an in-place rewrite.** L4: a document the loop may rewrite is one it
  can use to revise its own history.
- **The edit verifier checks WHAT, not WHY.** Reproducing the bytes is mechanical; the declared rationale and
  predicted effect stay the driver's claim and must be labelled as such.
- **No `skill` campaign subject yet.** `AgentSpec.capabilities[].version` is an immutable pin, so a skill
  campaign runs TODAY as an `agent` subject whose candidates differ in one capability pin. A new subject type
  is hypothetical surface until measurement shows the attribution conflation matters.

## Open questions

These ARE the design pass, not leftovers from it.

- **How much of the loop is the platform's?** The minibatch partition, reflection, edit merge/rank, the `L_t`
  schedule, the rejected-edit buffer and the meta prompt are the DRIVER's — research-directions already says
  the campaign record must not become responsible for search scheduling. The split, the disclosure tiers, the
  edit verifier, the protected region and the selection ledger look like the platform's. The boundary is
  argued, not settled, and the test is whether a second driver could be written against it.
- **Does the selection split steal power the confirmation set cannot spare?** Everything above assumes ten
  held-out cases survive. A fourteen-scenario campaign split three ways has nothing powered anywhere, and the
  honest answer may be that small campaigns keep today's model and only large ones split. Nothing here knows
  where that line is.
- **What bounds selection spend?** A count of evaluations is the obvious answer and may be the wrong one — a
  driver that evaluates cheaply and often is the behaviour this is trying to enable.
- **Is a rejected-edit buffer a platform record at all?** Everdict's round ledger is permanent, digested and
  append-only, which is stronger than an epoch-local buffer; what the driver needs is a READ over it. That may
  make G5 a query, not a schema.
- **The `L_t` schedule constants were not recovered.** The paper's cosine schedule is described but its actual
  values did not come back in the fetched text; an implementation needs them or its own, measured.
