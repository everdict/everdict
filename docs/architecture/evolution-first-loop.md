---
kind: decision
title: "The first evolution loop: a selection split, advice with a digest, and declared edits"
status: proposed
updated: 2026-09-11
---
# The first evolution loop

[Research directions](evolution-research-directions.md) catalogues eight directions (C1–C8) and says the first
implementation should combine C1 and C2. This decision is narrower and answers the question that document
left open: **what does the platform own, in which order is it built, and what refuses to be built at all.**

It settles C1, C2 and C5 into ONE loop. C3, C4, C6, C7 and C8 stay exactly as proposed there; nothing here
narrows them and nothing here depends on them.

Two papers drive it. `intent/2026-09-11-a-selection-split-and-declared-edits/` narrows SkillOpt (R38) to three
missing mechanisms and carries the arithmetic. WikiSkill (S00) is the seed of the
[literature review](evolution-literature-review.md) and is the larger reported effect — +15.0 points from
giving the PROPOSER durable knowledge, −2.8 from also giving it to the executor.

## The finding that makes them one project, not two

Both papers introduce a new store, and in this repository **both of those stores are already a READ over a
ledger that exists.**

- SkillOpt's rejected-edit buffer is epoch-local and lossy. Everdict's round ledger is permanent, digested and
  append-only, which is strictly stronger; what a driver needs is a query over it, not a schema. The accepted
  spec reached this conclusion on its own.
- WikiSkill's wiki is patch-edited. Everdict already considered that shape and refused it: `CampaignRound`'s
  `learned` field carries the argument in its own comment — *a document the loop may rewrite is a document the
  loop can use to revise its own history* (L4) — and chose append-only-with-the-round instead. That decision
  stands. What is missing is not a store; it is that a twenty-round campaign hands round twenty-one nineteen
  paragraphs of unranked prose with no contradiction handling and no ordering.

So the WikiSkill half is a **curated projection over the append-only ledger**, and the curator is a driver
procedure. The platform's entire share of it is one thing, below.

The two halves meet at exactly one seam: the brief. `campaignRoundBrief` already enforces the asymmetry
WikiSkill measured — the proposer sees the mechanism, the executor sees nothing — by construction rather than
by a reviewer noticing, and its own comment cites the ablation. That seam is not being rebuilt.

## The ownership rule

> **The platform owns a mechanism when a wrong answer to it would corrupt the EVIDENCE. Everything else is
> the driver's.**

This replaces the list the intent and the spec were each proposing, and it is testable in the way the intent
asked for — a second driver needs the platform's column and may disagree about every row of the other.

| mechanism | a wrong answer corrupts the evidence? | owner |
|---|---|---|
| train / selection / confirmation split | yes — a search that consults the exam invalidates the claim | platform |
| family accounting over CONFIRMING rounds only | yes — under-correction is a false positive with a p-value on it | platform |
| disclosure tiers (what a brief may say) | yes — the oracle rule; `redactHeldOut` and `heldOutIds` already own it | platform |
| edit set reproduces the candidate's registered bytes | yes — a declared edit that does not rebuild the artifact makes every later attribution fiction | platform |
| the digest of the advice a proposal was made under | yes — without it no arm of the C1 comparison can say what it actually read | platform |
| protected region inside the edited document | no — it protects a driver's consolidation from the driver's own next step | driver |
| rejected-edit buffer | no — and the round ledger already is one, permanently | driver (a read) |
| curation: ranking, contradiction, supersession of advice | no — advice decides nothing; `campaignAdoption` does not read it and must not | driver |
| minibatch partition, reflection, edit merge/rank, `L_t`, meta prompt | no | driver |

Two consequences, both of which make the accepted spec SMALLER:

- **The protected region leaves the platform.** Every candidate is already a new immutable capability version,
  so L4 is satisfied by the registry and not by a region check; and a declared edit set makes a touch of any
  region VISIBLE. Visible plus immutable is enough. The `consolidate` operation the spec invented to make
  protection machine-checkable is therefore not needed — and the spec flagged it as a guess at the cheapest
  fix rather than as a design it believed in.
  ⚠️ This holds only because the two arrive together: a frame declares protected regions inside the same
  opt-in that requires an edit set on every submission, so there is no frame in which a region is declared and
  no edit set is recorded. If that coupling is ever broken, protection becomes prose the driver polices itself
  and this paragraph is wrong.
- **The advisory digest is the whole platform surface of C1.** Not a knowledge store, not a curator, not a
  second authority: one rider on the round recording which bytes of advice produced this proposal, in the
  `{key, digest}` shape rounds already use for evidence. Everything else about curation is a driver procedure
  over records the platform already keeps.

## Why the split is first, and why that is arithmetic rather than taste

The intent's table, recomputed with this repository's own `fisherExactTwoSided` and `benjaminiHochberg`, for
one of ten held-out cases moving 0.20 → 0.60:

    trials/side      family=20 (today)    family=1 (one confirmation)
             20                  0.080                        0.315
             50                  0.620                        0.895
             75                  0.911                        0.988

A twenty-step epoch at ≈0.8 power on the confirming comparison costs **30,000** case executions today and
**2,200** with the split. The reason is structural: the family correction scales with how many times the
confirmation set is consulted, so consulting it once per candidate ties the cost of SEARCHING to the cost of
CLAIMING.

That makes the split the **experiment budget for every direction in the catalogue**, not one of the
directions. The first C1 comparison wants three arms of twenty steps; today that is 90,000 case executions
before anything has been learned, and no honest reading of the cost says a curator is worth trying at that
price. Build the split, and the same comparison is 6,600.

⚠️ The intent corrects an earlier and stronger claim, and the correction is kept here: the inner loop is not
arithmetically impossible under today's gate. It is ~13.6× more expensive for the same evidential standard.
One thing genuinely is impossible — at family ≥ 10 the smallest two-sided Fisher p at n=5 exceeds the
threshold, so a five-trial round cannot clear it for any effect size.

⚠️ **And the ratio counts CASE EXECUTIONS, which is not the whole cost.** Twenty selection evaluations per step
each pay a reservation, a dispatch and a scorecard, and nothing has priced that fixed overhead — the accepted
spec raises the same doubt. A selection evaluation at n=3 is cheap in trials and may not be cheap in wall
clock. So the first thing step 1 measures is its own overhead per evaluation, before anything is concluded
from the ratio above; a split whose per-evaluation tax dominates its trial saving has bought nothing and the
arithmetic will say so.

## The order

1. **The split, with family accounting that counts confirmations only.** The budget for everything after it.
2. **Declared edits, and the advisory digest, together.** They are the instrument, not two features: without
   an edit set a C1 comparison reads two scalars and cannot say whether the curated arm proposed *differently*
   or merely got luckier; without the digest it cannot say what either arm read.
3. **The curator, as a driver procedure**, and the three-arm experiment below.

Declared edits move ahead of curation for that reason alone. Neither the intent nor the research directions
put them in this order; the argument for it is that a comparison without a mechanism readout produces a number
nobody can act on, which is the failure mode this repository has already paid for at the measurement seam.

## What is refused

1. **No executor-side memory on this path.** WikiSkill's own ablation moved 63.7 → 60.9 when the executor also
   saw the wiki, and `campaignRoundBrief` already refuses it structurally. Runtime memory remains a legitimate
   product feature — evaluated as part of the CANDIDATE, with its own identity, exactly as the research
   directions say. It is not a loop mechanism and does not arrive by way of this work.
2. **The curator may not promote.** `KnowledgeEntryRecord` has a `proposed → active` review gate whose whole
   purpose is that machine advice does not silently become reviewed workspace knowledge. The curator writes a
   driver-owned projection and offers claims through that existing path; it never writes `active`.
3. **A selection evaluation can never answer `adopt`.** Selection ranks candidates with a cheap deterministic
   rule; adoption keeps the significance gate, the positive control (`examProvenBy` / `examInertness`) and the
   family correction. "Strictly greater" is right for ranking and would be a weakening if it ever decided an
   adoption — that asymmetry is what the split buys.
4. **No `skill` campaign subject yet.** A skill campaign runs today as an `agent` subject whose candidates
   differ in one capability pin. A new subject type is hypothetical surface until measurement shows the
   attribution conflation matters.
5. **The driver does not mutate its own adoption authority, budget accounting, or disclosure tier.** C7 states
   this as a bound on one experiment; here it is an invariant of the loop, because a search procedure that can
   widen its own evidence access has stopped being measurable at the first step it takes.

## The small-campaign question, answered by arithmetic that already exists

The spec's sharpest open concern is that nothing enforces a floor: a fourteen-scenario campaign can declare a
selection lane and leave a confirmation lane too thin to mean anything, and `campaignFrameDefects` only counts
scenarios.

There is already a refusal of exactly this shape. `unwinnableFrameDefect` runs at creation and nowhere else —
its comment explains why that is the one moment the arithmetic is both knowable and actionable — and refuses a
frame in which the exact test cannot return a p below `fdrAlpha / heldOutFamilySize` at the declared
`trialsPerCase`. It asks *can any case ever be significant*.

The extension asks the next question in the same form: **can a case moving by the frame's declared `minDelta`
ever be significant, at the declared trials, over the CONFIRMATION-role cases and the confirming family?** It
is the same pure arithmetic over the same two functions, it assumes no baseline rate and guesses no power
constant, and it answers in the same "cannot" vocabulary. With it, moving cases into the selection lane is
refused exactly when — and only when — it makes the exam unpassable for the effect the frame itself declares.

That converts the spec's documented risk into a creation-time refusal, and it answers "does the selection
split steal power the confirmation set cannot spare?" with "the frame is refused when it does", which is an
answer a constant could not have given.

## The first experiment

Three arms, one campaign family, equal total spend:

| arm | what the proposer reads |
|---|---|
| a | today's procedure — per-round `learned` prose, in order |
| b | same-budget flat history — every prior `learned` concatenated to arm c's token budget |
| c | the curated projection, frozen and digested at proposal time |

Primary measure: **confirmed adoptions per 1,000 case executions.** Mechanism readout, from the declared edit
sets: duplicate-edit rate, edit-surface distribution, repeated-failure rate.

Arm **b** is the control the research directions demand and the one WikiSkill's own ablation cannot supply:
removing proposer access there also removes the maintainer, so the paper's +15.0 is evidence that durable
development knowledge helps a proposer — not that this topology is the reason. Without arm b, a gain in c is
indistinguishable from "more context".

Reopening conditions:

- **b matches c** → the curator is dropped. The digest and the edit set stay: both pay for themselves in
  reproducibility whether or not curation earns its cost.
- **a matches b** → the advisory channel is not the bottleneck at this scale; the next spend goes to C3
  (search) or C4 (routing), and this decision is superseded rather than extended.
- **the split's selection lane does not correlate with the confirmation outcome** → selection is ranking on
  noise, and the cheap deterministic rule is the first thing to change, not the budget.

## The disclosure question the spec asked to have confirmed

The spec read the intent's "confirmation discloses nothing — not ids, not counts, not the fact that it ran"
literally, found it in conflict with the protocol as it stands (`campaign_decision` already returns
`roundsLeft`, and the brief already says which round this is), and resolved it as *nothing about the
OUTCOME* — scores, deltas, ids — while round counting stays visible. That reading is correct and is settled
here.

The reason is not convenience. The exclusions exist to stop a delegate learning something it could not
otherwise know; a driver that called the round door knows it called the round door, and hiding the count from
the caller who caused it is theater rather than an exclusion. The stricter reading would also have to
renumber rounds out of the brief, which removes a fact the proposer legitimately needs — where in the budget
it is — to protect nothing.

## What this decision does not do

It adds no effect path, no adoption reader and no new authority. It does not accept the research directions
document, which stays `proposed`. It does not answer what bounds selection spend — a count is the accepted
spec's provisional answer and the intent's own doubt about that shape is carried, not resolved. And it does
not settle whether the `L_t` schedule has usable published constants; that is driver state and stays outside
the platform either way.

## Primary sources

The mechanisms and their limits are catalogued in the [literature review](evolution-literature-review.md):
WikiSkill is S00, SkillOpt is R38, GEPA R01, ACE and ReasoningBank E08–E09. The cost arithmetic is reproducible
from `intent/2026-09-11-a-selection-split-and-declared-edits/power.mjs`, which calls this repository's own
significance functions rather than quoting the table.
