# Every refusal, what it means, and the repair

A campaign refuses in three places, and they fail differently on purpose. A ROUND is never refused for being
bad — a round that could not be compared is RECORDED as `comparable: false` with a reason, and counts as
rejected. The settle and the adopt doors refuse with a 409 instead, because there the caller is asking to
spend something.

Read this file when a round comes back not-comparable and you are about to change something at random.

## The round was recorded, with `comparable: false`

The pair produced no usable signal for THIS campaign. The round still costs a round of the budget and
counts toward `stopAfterRejectedRounds`, so a driver that keeps re-logging the same broken pair will halt
with `no_improvement` while nothing was ever measured. Check the detail before spending another round.

**"the pair is not comparable (verdict-policy mismatch or an unresolvable stamp)"** — the two batches were
judged under different verdict policies, or a stamp could not be resolved. Usually the two sides were
submitted with different grading configuration. Re-run both sides the same way.

**"the comparison is confounded — <axes> verifiably differ between the sides"** — the diff proved the two
sides ran in different worlds (two different resolved image digests, say). This is the one refusal no frame
field waives, and it should not be waived: a delta measured across two worlds is not evidence about the
change under test. Pin the axis that moved and run again.

**"no trial signal — campaign statistics need repeated trials on both sides"** — one or both scorecards ran
without repeats. Re-run with `trials` at least the frame's `trialsPerCase`.

**"the compared scenarios are not the frame's (missing: … ; extra: …)"** — the batch did not run exactly the
frame's `scenarios`. The frame is frozen, so this is repaired on the SCORECARD side: run the dataset slice
the frame names. If the dataset has genuinely changed, this campaign is over — open a new one against the
new exam rather than trying to make the old frame fit.

**"N case(s) ran fewer than the frame's K trials (…)"** — a thin side. The named cases did not complete K
trials, usually because some of them failed or were cancelled rather than because you asked for fewer.
Check those cases before assuming the trial count was the problem.

**"the judges are not the frame's (frame: …; baseline: …; candidate: …)"** — the frame pinned a judge set and
one of the sides ran a different one. Same repair as the scenarios: fix the batch, not the frame.

## `GET /campaigns/:id/decision` says `halt`

Not a refusal — an answer. Settle it and stop.

**`no_improvement`** — K consecutive rejected rounds. The hypothesis well is dry. Note this halt outranks the
budget one, so seeing it means the streak ended the campaign, not the budget.

**`budget_exhausted`** — `maxRounds` spent with the latest candidate not adoptable.

**`identity_unverified`** — the latest round WON, and the win cannot be trusted as identity. Two distinct
causes, and the detail says which:

- the comparison could not verify some world-identity axis (including
  `experiment_identity_unavailable`, which means the diff could not say what it compared at all);
- the candidate's scorecard sealed no spec digest, so the adoption could only name a version label.

Both are repairable by running one more round through a lane that seals what is missing — which is better
than waiving, because the waiver is frozen at open and this halt is telling you the evidence is thin. The
frame fields that turn each one off are in `frame-design.md`.

## `POST /campaigns/:id/settle` refuses (409)

**"the gate answers continue — the campaign settles only on an adoptable candidate or its own ending"** —
you settled too early. Ask `GET /campaigns/:id/decision` first; that is what it is for.

**"the campaign already settled"** — a close is once.

**"the campaign is closed — open a new one"** — from the ROUND door, on a campaign that already settled.

**"this campaign's frame predates the current adoption rules (…) — it stays readable, but it may not produce
new adoption evidence"** — an old campaign whose frame would not be creatable today (fewer than two held-out
scenarios, duplicate ids). It can still be read; it cannot produce new rounds. Open a new campaign.

**"a concurrent round landed first — re-read the campaign and log against its current state"** — two drivers
on one campaign. Re-read and retry; the round sequence is contiguous by construction.

## `POST /campaigns/:id/adopt` refuses

**404 "this campaign never authorized an adoption — settle it through the gate first"** — you skipped step 7.
Adoption spends what the close authorized; there is nothing to spend yet.

**409 "the proof presented is not the one this campaign recorded"** — the proof is compared as a DIGEST
against the stored operation, so a structurally-equal proof the campaign never issued is not authority.
Read the real one from `GET /campaigns/:id/adoption` rather than reconstructing it.

**409 "this adoption authorizes a different candidate — …"** — the candidate you named is not the one the
proof authorizes; the message says which field differs (version, or spec digest).

**409, after the registry write, naming what LANDED vs what this campaign proved** — the service registers
the spec, reads it back through the registry, digests THAT, and compares. A mismatch here means the document
now at that version is not the one the campaign measured. A version label cannot tell an evaluated candidate
from a saved one, which is why the read-back exists.

**409 "the registry write landed but its authorization could not be spent"** — the effect happened and the
ledger did not record it. The operation stays owed and is re-drivable: read `GET /campaigns/:id/adoption`,
see where it stopped, and present the same proof again. Registry versions are immutable, so re-registering
identical bytes is an idempotent no-op — this is safe to retry and must not be worked around by registering
a different version.

## The state that is not a failure

A campaign whose `state` reads `adopted` while its `operation` is still `decided` has decided and not yet
spent. That is a normal intermediate, and it is exactly what `GET /campaigns/:id/adoption` exists to show
you. The adoption also stays owed until the campaign's issue is resolved on the proving scorecard, which is
joined from whichever side lands second — so an operation sitting at `registered` is waiting for the issue,
not stuck.
