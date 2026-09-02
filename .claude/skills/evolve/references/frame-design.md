# The frame — every field, and what it costs to get wrong

The frame is frozen at open, digested, and referenced by that digest for the rest of the campaign. There is
no edit: a frame you want to change is a new campaign. That is the whole point — a threshold chosen after
seeing the rounds is not a threshold, and everything the adoption decision reads lives here so it cannot be
chosen later.

Two schemas, deliberately: `CampaignFrameSchema` validates what may be CREATED, `StoredCampaignFrameSchema`
what may be read back. A campaign written before a rule existed still decodes (its list must not break); it
simply is not adoption evidence.

## The fields

**`subject`** — `{type: "agent" | "harness", id, baselineVersion}`. One campaign optimizes one capability
family against one fixed baseline. A different baseline is a different question and therefore a different
campaign.

For a `code_evolve` campaign (evolving a harness's CODE), the subject's harness TEMPLATE must declare the
slot's `source {git, repo}` and `build {steps, workDir, capture}` — Everdict builds the candidate image into
its own managed store from those. A template with no recipe can be evolved by pinning, not by building. The
slot's `source.maintainer {profile}` names the delegation profile that maintains that repository; the driver
reads it (`resolve_harness_delegate`) instead of choosing an agent.

**`continues`** — the id of the campaign this one continues, when you are chaining. A walk that keeps
improving is a chain of campaigns, each starting from what the last one adopted; this field is what makes the
chain honest rather than merely convenient.

It is verified at open, and every part of it is refused rather than assumed: the predecessor must have
ADOPTED something, of the same subject; this campaign's `baselineVersion` must be the version it adopted; the
held-out rows must be the same rows; the `significance` block must be identical — one walk, one
pre-registration — and the chain's rounds so far plus this campaign's `budget.maxRounds` must still fit
inside the shared `heldOutFamilySize`.

That last one is the whole point and it is what makes a chain cost something: the family is spent across the
chain, so a five-round predecessor leaves five fewer tests for everyone after it. "The chain" is the whole
tree the predecessor roots — a sibling that continued the same campaign and halted spent its rounds against
the same held-out rows, and the open counts them too. Plan the chain's total length when you pre-register
the family, or accept that the walk ends when the family is spent. Omitting `continues` is always available
and always honest — it just means the new campaign's held-out rows should be rows nobody has asked yet.

**`scenarios`** — the exam, named case by case: `[{id, heldOut}]`, unique ids, at least two with
`heldOut: true` or the frame is refused at creation.

This is the field that quietly costs the most, because the round verdict requires the compared cases to be
EXACTLY this set — a case in the frame that the batch did not run, or a case the batch ran that the frame
does not name, both make the round incomparable with no warning at submit time. So write the frame from the
dataset you will actually run, and if the dataset changes underneath you, the campaign is over.

Two held-out is a floor, not a target. One case that moved is what a loop optimizing against a small set
produces by chance; the number exists so a held-out result cannot be a coin flip wearing the word evidence.
Pick held-out cases the loop will never be shown, and prefer more of them than feels necessary — they are
the only population the gate actually reads.

**`judges`** — judge ids, defaulting to none. If non-empty, the judges that SCORED each side — read from the
scorecard's scoring ledger, so an ingested batch's applied judges count exactly like a dispatched batch's —
must match this set exactly, so it pins the grading semantics the same way `scenarios` pins the exam. Leave
it empty only when you genuinely do not care which judges ran.

**`trialsPerCase`** — the statistical floor. Both scorecards must have run at least this many trials for
every case; a thinner side rejects the round and names the cases. One trial produces no significance signal
at all, so a campaign with `trialsPerCase: 1` can never adopt. Repeats are what let Fisher's exact test
distinguish a real change from a flaky one.

**`budget.maxRounds`** — the runaway bound. Scenarios and trials are fixed above, so rounds is the only axis
a loop can spend on. Exhausting it halts with `budget_exhausted`, and the round door REFUSES to append past
it — a round logged past the budget would be judged at a level the pre-registered family does not cover, so
the record enforces the bound rather than trusting the driver to ask.

**`stopAfterRejectedRounds`** — default 3. K consecutive rejected rounds halt with `no_improvement`, and
that halt outranks the budget one: "the hypothesis well is dry" names what is wrong, where "the budget ran
out" only names when it stopped mattering. Once it has fired the round door refuses further rounds, and a
round logged after it (rows from before the refusal existed) is not adoption evidence.

**`significance`** — the statistics, frozen with everything else the verdict depends on. `fdrAlpha` and
`heldOutFamilySize` are both REQUIRED of a new frame; `minDelta` (a practical effect-size floor) is optional.

`fdrAlpha` corrects across the CASES of one round — Benjamini-Hochberg over the per-case tests, which is the
only family the diff can see. `heldOutFamilySize` is the family it cannot: a campaign asks the same frozen
held-out population once per round, and any single round can end the walk by adopting. With three held-out
cases at alpha 0.05, a candidate that changes nothing wins a given round maybe 7% of the time, so a ten-round
walk adopts noise about half the time. `budget.maxRounds` bounds that and is a spending cap — it says when to
stop paying, not what the answer means.

So the family is pre-registered and the round is judged at `fdrAlpha / heldOutFamilySize`. It is at least
`budget.maxRounds` (every round consults the held-out set, so the budget is the floor), and larger when the
same held-out population will be carried into follow-up campaigns — chaining reuses the set, so the family
spans the chain and the frames must say so.

**This costs trials, and that is the price rather than a defect.** A total flip is the strongest per-case
result available, and its p-value is fixed by N alone:

    N=3   0/3 → 3/3   p = 0.10      never significant, at any family size
    N=5   0/5 → 5/5   p = 0.0079    clears a family up to 6
    N=6   0/6 → 6/6   p = 0.0022    clears a family up to 23
    N=7   0/7 → 7/7   p = 0.00058   clears a family up to 86

Pick N and the family together. A twenty-round campaign at N=5 is a campaign that cannot adopt anything, and
it will spend its whole budget finding that out.

## What makes a round WIN

The gate looks only at the LATEST round — adoption is of the current variant, never archaeology over the
trace. A loop that beat its baseline in round 4 and regressed in round 5 must return to the winner
explicitly by running it again.

That round wins when all of these hold:

    comparable                     the pair produced a real signal
    a held-out block exists        a round that cannot separate training from held-out is not evidence
    no divergent observations      unless the frame waived it
    unclear within maxUnclear      if the frame bounded it
    coverage at least minimumCoverage   if the frame demanded it
    heldOut.improvements >= 1 AND heldOut.regressions === 0

Note the last line reads the HELD-OUT counts, not the whole round's. Improving where the loop has been
pushing is evidence about the search, not about the capability.

**`oracleScope`** — repository path patterns that ARE the exam: the dataset, the judge rubrics, the eval
configs, the tests the graders run. Default empty. Non-empty means the round door reads what the candidate's
pull request changed (from the repository the candidate scorecard's origin names) and a change inside the
scope makes the round `comparable: false` — "the candidate touched the oracle", with the paths on the verdict
as `oracleTouched`. A change that CANNOT be read — the scorecard names no pull request, the listing was
truncated, the repository could not be asked — is non-comparable too: "could not check" is not "clean".

The pattern language is small: `*` within a segment, `?` one character, `**` across segments, a trailing `/`
for a directory and its subtree, and a bare path for itself or its subtree (`pathMatchesPattern` in
`@everdict/domain`). This is the field that makes a code-changing campaign honest; a frame for a loop that
only moves pins can leave it empty.

**`delegation`** — `{ttlSec, maxUsd?}`, the per-round budget for the coding agent a round delegates to
(`code_evolve`). Default absent. Declared, every round must name the sandbox session that produced its
candidate (`delegationRunId`), and the round door reads what that session cost off the run ledger — the TTL
it was granted, the spend it metered — refusing (409) a round whose session ran past either. A session the
ledger cannot read, another workspace's, or one that is not a sandbox is refused too. Without the field a
named session is still recorded on the round, so the trace says who wrote the candidate.

## The three waivers, and the refusal each one turns off

All three default to refusing. Each is a recorded decision made at open, in the frame, where it is frozen —
which is the only place a waiver means anything.

**`allowUnverifiedIdentity`** — turns off the `identity_unverified` halt raised when the winning round's
comparison could not verify some world-identity axis. The axes are recorded either way, and an adoption that
proceeds over them says so durably in its proof.

**A loop over INGESTED scorecards needs this.** An ingested batch seals no manifest, so every axis reads
unverified on every round — there is no lane to re-run through that would seal one. The halt's detail says
so and names this field; the frame that omits it cannot be repaired in place.

This is not the same as a CONFOUND. An axis the diff verified as actually DIFFERENT between the two sides —
two different resolved image digests, say — makes the round not comparable, and no frame field waives it: a
delta measured across two different worlds is not evidence about the change under test.

**`allowLabelOnlyAdoption`** — turns off the `identity_unverified` halt raised when the winning round's
candidate scorecard sealed no spec digest, so the adoption could name only a version LABEL. A candidate
substituted between the evaluation and the registration would then be undetectable.

Prefer the other repair: run the candidate through a lane that seals a manifest. A batch seals
`harness.specDigest` when the harness is resolved from the registry, so the usual cause of a label-only
round is a harness that is not registered in this workspace.

**`observationPolicy.allowDivergent`** — turns off the refusal of a round whose judges, shown the platform's
own observation account, said the candidate's story does not match what the platform watched it do. That is
the strongest negative evidence this system can produce. Waive it only when you have decided, in advance,
that you are optimizing through known noise.

`observationPolicy` also carries `minimumCoverage` (how much of the round must actually have been assessed,
as a fraction of the JUDGE scores — the only scores that can carry an assessment; a cost or a step count
never enters the denominator) and `maxUnclear`. Both are absent by default,
which is what every campaign had. Set `minimumCoverage` only once observations are genuinely being produced:
the policy is read from the POLICY, not from the data, so a frame demanding coverage refuses a round that
carries no observation block at all — which is correct, and will stop a first campaign dead if the
observation channel is not wired.
