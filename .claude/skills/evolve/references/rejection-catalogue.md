# Every refusal, what it means, and the repair

A campaign refuses in four places, and they fail differently on purpose. A ROUND is never refused for being
bad — a round that could not be compared is RECORDED as `comparable: false` with a reason, and counts as
rejected; the round door refuses only when the campaign is already over by its own rule, or when the row
could not hold what was sent. The settle and the adopt doors refuse with a 409 instead, because there the
caller is asking to spend something.

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

**"the candidate touched the oracle — <paths> fall inside the frame's oracle scope"** — the candidate's
pull request changed the exam (`oracleScope`). The round is not a candidate, whatever it scored; the paths are
on the verdict as `oracleTouched`. Close that pull request, re-brief the delegate with the paths named as a
constraint, and spend a new round.

**"the candidate was seeded with the exam's findings — <seeds> carry evidence over the frame's held-out
scenarios"** — a skill or knowledge seed the candidate version ships with was born from a scorecard over the
frame's held-out cases: the exam mounted into the candidate (`seedLeak` names the seeds on the verdict). Register a
candidate version without those seeds; knowledge derived from THIS campaign's evidence feeds the proposer, never
the candidate.

**"the candidate's seeds could not be checked against the frame's held-out scenarios: …"** — the candidate
version is not registered, or the seeds' provenance (skill versions, knowledge entries, their scorecards) could
not be read. "Could not check" is not "clean".

**"the frame declares an oracle scope and the candidate's change could not be checked against it: …"** —
neither Everdict's build record nor the scorecard's origin names a pull request, the listing was truncated, or
the repository could not be asked (no GitHub App on it, a failed read). "Could not check" is not "clean". The
build record is read FIRST: ask `build_campaign_candidate` for the build with the pull request's `repo` +
`prNumber`, so the candidate Everdict built is the change the oracle reads. A batch you submitted yourself may
carry them on `origin.repo`/`origin.prNumber` instead; otherwise fix the App installation.

## `POST /campaigns/:id/rounds` refuses (409 / 400)

A round is never refused for being BAD — but it is refused when the campaign is over, or when the row could
not hold it.

**"all N budgeted rounds are logged …"** (409) — the budget is spent. The record enforces its own ending:
a round past the budget would be judged at a level the pre-registered family does not cover. Ask the
decision and settle; a longer walk is a new campaign (or a chain).

**"K consecutive rounds were rejected by round N — the campaign ended by its own rule"** (409) — the
rejected streak fired. Same repair: ask the decision, settle.

**"this campaign's frame budgets the delegation, so the round must name the sandbox session …"** (400) —
the frame has `delegation` and the round came without `delegationRunId`. Name the session (its run id).

**404 "delegation session '…' not found" / 400 "run '…' is not a sandbox session"** — the named run is not
in this workspace's ledger, or is a case run rather than a session.

**"delegation session '…' was granted Ns and the frame budgets Ms per round" / "spent $X and the frame
budgets $Y"** (409) — the session ran past the frame's delegation budget; the round is refused, not scored.
Open the next session within the budget (`create_sandbox` with `ttlSec` at most the frame's).

**"the build ledger could not be read, so whether Everdict built candidate … cannot be established"** (500) —
Everdict's own build store did not answer. Nothing was logged: a round whose provenance cannot be read is not
logged wearing the caller's coordinates. Retry once the ledger answers.

**"the round cannot be stored as sent: …"** (400) — a caller field the row cannot hold: `hypothesis` 1 to
2000 characters, `learned` up to 4000 (a new round needs at least 10 on either transport), `candidateVersion`
1 to 100. The bounds are the record's, applied at the write on both doors, so a stored campaign always
reads back.

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
frame fields that turn each one off are in `frame-design.md`, and the detail names the one that applies.

⚠️ For a loop over INGESTED scorecards both causes are permanent: an ingested batch seals no manifest (every
axis unverified) and names no registry document (label-only), and there is no lane to re-run it through.
Such a frame declares `allowUnverifiedIdentity` and `allowLabelOnlyAdoption` at open; one that did not is
a campaign that can neither adopt nor settle on a win — abandon it in its issue and open a new one.

## `POST /campaigns/:id/builds` with `slots` (a build set) refuses, or its set fails

**400 "a build set names at least two DISTINCT slots"** — one slot is a plain build (`slot`); a repeated slot is one
build twice.

**400 "slot 'x' has no build recipe on this template"** — every member needs `source` + `build` on its template
service. Add the recipe in a new template version.

**Set `failed` "the members observed different commits … the pull request moved between builds"** — the head moved
while the members were checking out. Start the set again on the current head.

**Set `failed` "…already exists with different pins — this set cannot mint under its name"** — the set's derived
version name is taken by a different document. A set re-driven after a crash re-mints the SAME name and is accepted
when the pins match; a different document under it is refused rather than overwritten.

## `GET /campaigns/:id/rounds/:seq/evidence` refuses

The evidence a round sealed — what it saw, case by case — served from the immutable object the round names.

**404 "round N carries no evidence record"** — the round was logged before the record existed. Nothing is
invented for it; read its scorecards directly.

**500 "round N references evidence at … and the store holds nothing there"** — the round names bytes the
store does not have. An escalation, not an empty answer: the evidence is missing and an operator should know.

**409 "the evidence stored at … does not digest to what round N sealed"** — the bytes changed under the seal.
Refused rather than served: a reader must never be handed evidence the round did not seal.

## `POST /campaigns` refuses a chain

Only when the frame carries `continues`. Every one of these means "this is not a continuation of that
campaign", and the honest repair is usually to drop `continues` and open a fresh campaign on held-out rows
nobody has asked yet.

**"campaign 'X' adopted nothing, so there is no version to continue from"** — the predecessor halted, or is
still open. A chain continues a result, not an attempt.

**404 on the predecessor** — a chain naming a campaign that does not exist refuses at the read.

**"a chain follows one subject"** — the predecessor optimized a different agent or harness.

**"a chain starts from what its predecessor proved"** — your `baselineVersion` is not the version the
predecessor adopted.

**"that is a different exam, so its tests do not carry"** — the held-out scenario ids differ. The
predecessor's tests were spent against a population this campaign is not touching, so carrying the count
would be arithmetic about the wrong thing.

**"a chain shares one pre-registration"** — the `significance` block differs. Two levels in one walk means
rounds judged by two rules, chosen after seeing data.

**"this chain has spent N of its F pre-registered held-out tests and this campaign budgets M more"** — the
arithmetic, and the reason the field exists. N counts every campaign in the TREE the predecessor roots —
a halted sibling that continued the same campaign spent its rounds against the same rows. Either shorten
this campaign's `budget.maxRounds`, or start a new chain that pre-registers a larger family and accepts the
smaller per-round level that buys.

## `POST /campaigns/:id/settle` refuses (409)

**"the gate answers continue — the campaign settles only on an adoptable candidate or its own ending"** —
you settled too early. Ask `GET /campaigns/:id/decision` first; that is what it is for.

**"the campaign already settled"** — a close is once.

**"the campaign is closed — open a new one"** — from the ROUND door, on a campaign that already settled.

**"this campaign's frame predates the current adoption rules (…) — it stays readable, but it may not produce
new adoption evidence"** — an old campaign whose frame would not be creatable today: fewer than two held-out
scenarios, duplicate ids, an undeclared `significance.fdrAlpha`, or an undeclared or understated
`significance.heldOutFamilySize`. It can still be read; it cannot produce new rounds. Open a new campaign.
The message names every defect, so it tells you exactly what the new frame must declare.

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

## `POST /campaigns/:id/merge` refuses

The code half of an adoption. Only when the adopted candidate named a pull request — on Everdict's build
record, else on the scorecard's origin — does the close record a code debt; this door pays it through the
workspace GitHub App.

**404 "this campaign never authorized an adoption"** — settle first.

**409 "the proof presented is not the one this campaign recorded"** — read it from
`GET /campaigns/:id/adoption`.

**409 "this adoption carries no code debt"** — neither the build record nor the candidate scorecard named a
pull request (a pin-only campaign, or a build asked for from a bare branch). Nothing to merge.

**409 "the adopted bytes are not registered yet"** — adopt first. Code is promoted only behind an adoption that
landed.

**409 from GitHub, "head moved after the round measured it" / "not mergeable"** — the pull request changed
after the round, or has conflicts. Re-run the round on the new head, or resolve the pull request and merge
again; the debt stays owed.

**404 "no workspace GitHub App is configured on this deployment"** — the deployment cannot merge from here.
Merge in GitHub; the debt is recorded as owed and a chain over this adoption stays refused until an
operator with the App pays it.

**A chain refused with "adopted code that is not merged"** — `POST /campaigns` with `continues` over an
adoption whose code debt is owed. Merge it and open again; a chain starts from what is on the default branch.

## The state that is not a failure

A campaign whose `state` reads `adopted` while its `operation` is still `decided` has decided and not yet
spent. That is a normal intermediate, and it is exactly what `GET /campaigns/:id/adoption` exists to show
you. The adoption also stays owed until the campaign's issue is resolved on the proving scorecard, which is
joined from whichever side lands second — so an operation sitting at `registered` is waiting for the issue,
not stuck.
