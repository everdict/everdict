# Intent: every dataset arrives from outside, so a nightly loop cannot learn from what this workspace actually did

Author: maintainer (requested in conversation — "everdict should support SkillOpt-Sleep too"). Status: draft

Design: owed — `pnpm design --next` picks this up when it is accepted. The oracle question in §"Open questions"
is the design pass, not leftovers from it: a mined reference is an instrument this repository already refuses
to take on trust, and nothing below resolves that.

## Problem

SkillOpt-Sleep (`microsoft/SkillOpt`, `skillopt_sleep/`) is the deployment-time half of SkillOpt: instead of
training a skill against a benchmark, it gives a *working* agent a nightly cycle over the operator's own usage —
**harvest** local coding-agent transcripts → **mine** the tasks that recur → **replay** them → **consolidate**
(reflect → bounded edit) → **gate** on a held-out slice of those same real tasks → **stage** a proposal a human
adopts. Its published stress case is the argument for the shape: with the gate off, the optimizer learned
"answer with the document-title string, verbatim", an obedient model complied, and SearchQA accuracy fell
0.554 → 0.026 over five nights; the gated twin rejected every one of those edits and lost nothing.

Everdict already holds the entire back half of that loop, and holds it harder:

| Sleep stage | here | |
|---|---|---|
| replay | real batches through `POST /scorecards` | |
| gate | `GET /campaigns/:id/decision` | a significance test (Fisher + BH at `fdrAlpha / heldOutFamilySize`), not "strictly greater" — plus `examProvenBy` / `examInertness`, a positive control that refuses a dead instrument |
| stage | the close leaves a spendable authorization; settling is not adopting | |
| adopt | `adopt_campaign_candidate`, which registers the version and reads it back | |
| nightly | Temporal Schedules → `schedule.fired` (shipped, live-verified) | |
| the consolidation pass itself | the `memory_consolidation` first-party skill | whose own comment says it reinterprets "Claude Code's nightly consolidation as a SKILL a workspace imports and schedules" |

Bounded edits, a protected region and a selection split are already requested in
`intent/2026-09-11-a-selection-split-and-declared-edits/`. So this intent is not "build SkillOpt-Sleep". Almost
all of it is built. What is missing is one thing, and two things follow from it.

### The gap: the dataset door only opens outward

`BenchmarkSource` in `packages/datasets/src/catalog.ts` is `huggingface | jsonl | terminal-bench`. Every case
this platform has ever measured arrived from **outside** — a hub, a file the caller pasted, a published task
set. Nothing turns *what happened here* into an `EvalCase`.

That is not an oversight; it is what a harness-agnostic benchmark runner is. But it is exactly the first two
stages of a sleep cycle, and without them the loop has nothing to be about. `docs/architecture/replay.md`
records a run richly — trace, snapshot, `envDeltas`, recordings — and records it **so a human can re-watch it**.
A recording is evidence about one run. A case is a question you can ask again. No path turns the first into
the second, and a nightly loop is the request for that path.

The maintainer's decision is that the mined source is an **adapter**, covering both everdict's own run history
and external local transcripts (`~/.claude`, `~/.codex`) behind one seam. ⚠️ An adapter argued from one source
is an untested abstraction with a second implementation assumed; this one is only worth building if both
sources shape it at the same time, because the internal source arrives with sealed provenance and the external
one arrives as a text file of uncertain origin, and a seam that has only met the first will be wrong about the
second in the field.

### What follows (1): the sleep pass we already ship is unmeasured

`memory_consolidation` runs the dream pass over `memory/` today with **no gate of any kind**. It is protected
instead by a rule — *"consolidation reorganizes what is WRITTEN — it never invents"* — and that rule is a real
mitigation: a pass that cannot author a new claim cannot author the wrong one that cost SkillOpt 52.8 points.
But it can still delete a line that was load-bearing, merge two memories into one that is weaker than either,
or prune an index entry every future conversation was relying on, and nothing measures any of that. Everdict
sells the position that an unmeasured change to a thing agents read is not a safe change. We ship one.

### What follows (2): a nightly cadence is arithmetically unusable on today's gate

A round is judged at `fdrAlpha / heldOutFamilySize`, and `heldOutFamilySize` must cover every round that
consults the held-out set. A nightly loop consults it nightly, so a month is a family of thirty.

Re-derived today with this repository's own `fisherExactTwoSided` and `benjaminiHochberg`, via `power.mjs` in
the sibling intent — one of ten held-out cases genuinely moving 0.20 → 0.60:

    n/side     family=20 (today)     family=1 (one confirmation)
        20                 0.082                          0.320
        50                 0.625                          0.895

Eight percent. And at `family >= 10` with five trials a side, the smallest attainable two-sided Fisher p
(0.0079) is already above the threshold, so such a round cannot clear it for **any** effect size. A nightly
loop is therefore the strongest argument yet for the selection split in the sibling intent — not an
enhancement on top of it, but the case that fails without it. The two should be sequenced, and this one is
downstream.

## Proposed outcome

- A dataset can be **authored from observed work** and not only imported: an adapter takes a source of past
  agent activity and yields `EvalCase[]` that carry, at birth, where each case came from.
- Both source kinds exist at the seam's first landing — everdict's own sealed run history, and an external
  local transcript — so the abstraction is argued by two implementations rather than by one and a hope.
- A case mined from a transcript is distinguishable, everywhere it travels, from a case with a published
  reference. Its reference is labelled as mined, and a surface that reads structured fields can see that
  without reading prose.
- A workspace can schedule a nightly pass whose proposals are **decided by the campaign gate** rather than by
  the pass's own confidence — which makes `memory_consolidation` a measured operation instead of a careful one.
- An operator adopting a mined skill can see which of their own recurring tasks it was proven on.

## Affected users and systems

`packages/datasets` (the new source kind and its adapter seam), `packages/contracts` (the mined-case
provenance and reference labelling), `packages/application-control` (the miner's read over run history; the
first-party driver skill; `memory_consolidation` gaining a gate), `packages/self-hosted-runner` (the only
component that can reach a local `~/.claude` transcript at all), `apps/api` (the doors a nightly driver needs),
`apps/web` (showing an operator which of their tasks a proposal was proven on).
Depends on `intent/2026-09-11-a-selection-split-and-declared-edits/`. Sources:
`docs/architecture/evolution-literature-review.md` R38, `docs/architecture/replay.md`,
`docs/architecture/scheduled-evals.md`.

## Constraints

- **No new spine domain.** Mining is a `datasets` source and a driver skill. The trust gate (CLAUDE.md §5) is
  satisfied by strengthening *reproduction* — a case that can be asked again — not by adding a sleep domain.
  The campaign record must not learn to propose; `evolution-lineage.md` §"Deliberately not" says no campaign
  workflow engine, and a nightly loop is the orchestration that clause is about.
- **Provenance is born at the source (L3).** A mined case records the run, session or transcript it came from
  at the moment it is minted. It is never re-derived later from the case's rendered text.
- **A mined dataset is frozen like any other frame input (L4).** The nightly loop may mint a new dataset; it
  may not edit the one last night's verdict rests on.
- **The oracle may not be authored by the family under test.** A rubric mined from an agent's own transcript
  and then used to judge that agent is the exam written by the candidate. Whatever the answer is, it passes
  `examProvenBy` / `examInertness` like every other instrument, or it does not ship.
- **Harvesting external transcripts is reading someone's unredacted work.** SkillOpt-Sleep says plainly that
  its outbound prompts "are not currently guaranteed to be secret-free". Everdict has a secret-free execution
  envelope; a transcript harvester that ignores it would be the first hole in it.
- **`memory_consolidation`'s "never invents" rule stays** whatever gate is added. The gate answers a different
  question from the rule, and removing the rule because a gate now exists would trade a guarantee for a test.

## Open questions

These ARE the design pass.

- **Where does a mined case's reference come from?** SkillOpt-Sleep answers `reference_kind: rubric`, mined by
  an LLM from the transcript. Everdict treats an evaluator as a trust artifact. The options — a human confirms
  each mined reference, the reference is the recorded outcome of a run a human already accepted, or a mined
  rubric is admissible only under a declared waiver the way `allowUnverifiedIdentity` is — are not equally
  cheap and are not equally honest. This is the question that decides whether the rest is worth building.
- **What makes a task "recurring", and who says so?** A miner that clusters by surface similarity will merge
  two tasks that differ in the way that matters. A cluster is a claim about sameness and something has to be
  able to refuse it.
- **Is the internal source a `datasets` adapter at all?** Everdict's own runs are already sealed records with
  identity; passing them through a text-shaped import seam may throw away exactly the provenance that makes
  them better than the external source. The seam may need to admit them at a different altitude.
- **What does the nightly driver do when the gate says `continue` forever?** A campaign halts on its frame's
  ending; a nightly schedule has no ending. Which of the two owns the stop is not obvious, and a loop that
  re-opens a campaign every night has found a way to spend an unbounded family.
- **Does a mined case ever graduate?** A case proven useful over months is indistinguishable from a benchmark
  case except in where it came from, and nothing here says whether that distinction should ever expire.
