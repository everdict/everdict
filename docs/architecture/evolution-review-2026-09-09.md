---
kind: wiki
title: "Evolution follow-up review — 2026-09-09"
status: current
updated: 2026-09-09
anchors: [packages/application-control/src/evolution/campaign-service.ts, packages/application-control/src/capability/first-party.ts, packages/db/src/evolution/experiment-family.ts, packages/contracts/src/execution/grader.ts]
---
# Evolution follow-up review — 2026-09-09

Reviewed commit: `f75f86b790efac38a874e16aea3c90eba4b2448e`.
Scope: the fixes following the review of main at
`25814996b975a8b721272396b547854adde6fd6f`, including implementation commits
`8f538e4f` and `891eb99b` and their verification record.

**All four findings are closed.** Each carries the repair, the committed regression test,
and the neutralization under which that test was observed red. The status lines below were
`open` when this review was filed; the reproductions are kept verbatim, because a finding
whose reproduction is deleted with its fix cannot be re-checked.

See [the implementation overview](evolution-review-follow-up.md), the
[request these repairs were filed under](https://github.com/everdict/everdict/blob/main/intent/2026-09-09-evolution-follow-up-findings/intent.md)
and [the original verification record](https://github.com/everdict/everdict/blob/f75f86b790efac38a874e16aea3c90eba4b2448e/intent/2026-09-08-evolution-evidence-authority/review.md).
P1 affects adoption integrity or the ability to complete an evolution campaign;
P2 affects semantic identity and extension behavior.

## R1 — P1: oracle commit coordinates are not bound to evaluated code

Status: closed — `packages/db/src/evolution/oracle-commits-are-built.counterexample.test.ts`.

Source: `packages/application-control/src/evolution/campaign-service.ts`,
`candidateSourceOf` and `oracleCheck` (lines 201 and 1355 at the reviewed commit).
The HTTP and MCP submission paths accept caller-authored origin coordinates in
`apps/api/src/api/scorecard/scorecard.routes.ts` and
`apps/api/src/api/scorecard/scorecard.mcp.ts`.

The baseline SHA always comes from its scorecard's `origin.sha`. The candidate also
falls back to its origin when no matching platform build record exists. Storing these
coordinates does not prove which code the evaluation ran. The check verifies repository
agreement and echoes the requested SHAs into its receipt, but does not establish their
relationship to the evaluated images.

Counterexample: evaluate baseline code B and candidate code A, where A changes a protected
oracle file. Submit the baseline origin with SHA A. Even when the candidate has a genuine
platform build record for A, the oracle compares A to A and receives no changed paths.
Its `clean` receipt therefore answers a different question from the evaluated B-to-A change.

A direct production-method probe supplied a baseline origin equal to the candidate's
platform build SHA. With a controlled comparison reader returning an empty same-commit
listing, `oracleCheck` returned `kind: "clean"` and identical baseline/candidate SHAs.
This probe did not run a live GitHub comparison or the full adoption adapter.

Required repair: resolve both sides from verified build/execution provenance bound to
their evaluated document or image digests. Caller origin fields may remain annotations;
missing verified provenance must produce an explicit unverifiable outcome.

Closure test: submit a real baseline/candidate pair with a forged baseline origin and
prove it cannot obtain a clean oracle result. Include a valid provenance pair and a
candidate without a platform build record as separate cases.

**Repair.** `oracleCheck` resolves both commits from Everdict's own build ledger and from
nothing else. The candidate's comes from the `built`/`minted` record whose minted instance
version is the round's candidate; the baseline's from the record that minted the frame's
`baselineVersion`, searched up the `continues` chain, because a successor's baseline is its
predecessor's adopted candidate and that is the campaign whose ledger built it. The join to
the evaluated arms is the instance version, which `logRound` has already checked against each
scorecard's own harness stamp — so no caller-authored field enters the decision. A missing
build record on either side is `unverifiable` naming which side and what would supply it;
`OracleCheckReceipt.commitProvenance` records that the commits are the platform's word, and
its absence marks a receipt written before this change, whose commits were the submitter's.

⚠️ **A campaign whose baseline Everdict did not build can no longer use an oracle scope.**
That is the price of the property, stated rather than worked around: `code_evolve` now says
to build the baseline once before round 1. A round's `verdict.candidateSource` still carries
the scorecard's origin as provenance (D4) — the merge effect reads that block, and binding
it to verified provenance is a separate question this change does not close.

## R2 — P1: spent unreported attempts cannot reach a campaign ending

Status: closed — `packages/db/src/evolution/spent-attempts-reach-an-ending.counterexample.test.ts`.

Source: `packages/db/src/evolution/experiment-family.ts`, `reserveInFamily`, and
`packages/application-control/src/evolution/campaign-service.ts`, `decision` and
`settle` (lines 970 and 1455 at the reviewed commit).

Reservations remain spent after a submission failure or an unreported evaluation.
However, both decision and settlement call `campaignAdoption` with only the frame and
recorded rounds. The durable attempt ledger is absent from that decision.

A probe using the production in-memory store and campaign service reproduced:

| Step | Observed result |
| --- | --- |
| Reserve the sole attempt, then leave the scorecard unavailable | Family has `limit: 1`, `consumed: 1`; no rounds |
| Ask for the decision | `continue`, `roundsLeft: 1` |
| Reserve another attempt | Conflict: evaluation budget exhausted |
| Settle the campaign | Conflict: the gate answers continue |

The conservative decision to retain spent capacity is correct. Its consequence must also
reach lifecycle decisions; otherwise the campaign cannot progress or settle normally.

Required repair: account for consumed and outstanding attempts when deciding an ending.
Distinguish an attempt that can still complete from one whose result is irrecoverable;
keep lost attempts spent without leaving the campaign permanently open.

Closure tests: reservation followed by failed scorecard creation, cancelled execution,
and a completed but unreportable pair. Also prove that exhaustion does not prematurely
close a campaign whose already-reserved comparison can still finish and win.

**Repair.** `budget.maxRounds` has one owner now — `campaignSpendOf` (`@everdict/domain`)
— read by the adoption gate, by the write-side round refusal and by the reservation door
alike. A campaign ends on the budget when `consumed >= maxRounds` **and** nothing is
outstanding; `continue.roundsLeft` counts what the door will still hand out rather than
what the rounds happen to show.

An attempt is outstanding unless a bound arm's batch is absent or terminal in a state that
is not `succeeded`. A batch the store could not be read for stays outstanding and the
refusal says so — ending a campaign on a read that did not happen is the collapse L2
refuses, and the cost of the other direction is only that a settle waits. Lost attempts
stay SPENT: nothing here refunds budget. `logRound` resolves its own reservation before
asking the ending, so the comparison being reported can never be what closes the campaign.

## R3 — P1: first-party evolution procedures cannot satisfy the reservation contract

Status: closed — `apps/api/src/api/campaign/evolution-procedures-reserve.counterexample.test.ts`
and the derived procedure assertions in `packages/application-control/src/capability/first-party.test.ts`.

Source: `packages/application-control/src/evolution/campaign-service.ts`, `logRound`
(line 1023 at the reviewed commit), and
`packages/application-control/src/capability/first-party.ts` (agent baseline at line 760).
The ingest request contract is in
`packages/application-control/src/scorecard/scorecard-requests.ts`.

Every new round requires an unreported reservation owning both scorecard IDs. Yet the
first-party agent procedure still runs `try_agent`, uploads its traces through
`ingest_scorecard`, then calls `log_campaign_round`. Ingest has no campaign reservation
binding, so that supported procedure cannot produce an acceptable pair. Its identity
waivers do not waive this new prerequisite.

The harness/code procedures also omit the new reservation field, and the harness
procedure recommends baseline reuse across rounds. The current ledger binds each arm
to one comparison and does not support that reuse contract. The code-delegation procedure
still supplies a custom brief without opting into the campaign evidence grant flow.

This finding comes from tracing the shipped procedures and request contracts to the new
refusal; the complete agent/shadow execution path was not run during this review.

Required repair: provide a supported reservation-before-execution path for each evolution
subject, including agent shadow execution and subsequent ingestion. Update the first-party
procedures and their baseline/delegation instructions to match the executable contract.
Do not repair this by accepting arbitrary previously completed scorecards.

Closure test: drive each shipped agent, harness and code procedure from reservation
through actual submission/ingestion and round logging, without a fixture that automatically
reserves completed results at settlement time.

**Repair.** `ingest_scorecard` carries `campaignEvaluation`, the same request the submit
path takes, and reserves before anything is uploaded. An upload names its exam by
REPETITION rather than by a `trials` field, so `ingestedExam` derives the pair the ledger
checks — a ragged upload (five tries for one scenario, one for another) is refused instead
of passing as a full arm. A deployment with no family ledger refuses a campaign ingest
rather than accepting an unreserved one.

All three procedures gained a step 0.5 that reserves before executing, on both arms, and
`harness_evolve` lost its baseline-reuse recommendation in both places it appeared — the
ledger binds each scorecard to one comparison, so every round runs both arms, and the
pricing note says so. `code_evolve` now asks `get_campaign_round_brief` for its brief
instead of composing one: that renderer is also the guard that keeps held-out ids, pass
rates and judge rationale away from the delegate.

The procedure assertions are derived and run over EVERY evolve procedure, because the three
share no symbol and a fourth written after this lesson would have nothing to grep.

## R4 — P2: inline criterion coordinates still collapse during collection

Status: closed — `packages/domain/src/scorecard/measurement-identity.test.ts`.

Source: `packages/contracts/src/execution/grader.ts`, `measurementIdentityOf`
(line 47 at the reviewed commit), and `packages/graders/src/judge.ts`, `criterionMetric`.
`packages/contracts/src/harness/rubric-spec.ts` permits both criterion IDs below.

The judge emits explicit structured criterion coordinates, but `sanitizeScore` overwrites
them by parsing the display metric. For inline producer `judge`, the collector strips a
`judge:judge:` prefix as though it were a namespace. Two distinct criteria therefore
become the same measurement identity:

| Original criterion | Display metric | Criterion after collection |
| --- | --- | --- |
| `x` | `judge:x` | `x` |
| `judge:x` | `judge:judge:x` | `x` |

Both rows have producer `{ kind: "grader", id: "judge" }` and canonical metric `judge`.
A direct `sanitizeScore` probe reproduced this even when the input already contained the
correct structured coordinates. Structured deduplication and criterion-specific policies
can consequently conflate distinct measurements. Under the default policy these criteria
are diagnostic, so this is not a claim that the default overall verdict always changes.

Required repair: have the trusted collection boundary carry explicit criterion coordinates
and namespace mode from the producer contract. Do not infer them from an ambiguous label
or trust arbitrary producer-supplied identity fields without validation.

Closure test: emit both criteria through the real inline judge and collector, verify that
they remain distinct through deduplication, and apply a criterion-specific policy. Retain
the existing inline-versus-registered-judge collision regression.

**Repair.** The producer descriptor carries the criterion SHAPE its construction writes
(`ScoreProducer.namespacesJudgeCriteria`, `judgeMetricShapeOf`), so the collector strips one
declared prefix instead of trying the namespaced one and falling back to the bare one. Both
collection boundaries supply it from the producer contract: `safeGrade` reads it off the
runtime `JudgeGrader`, and `sanitizeSubmittedResult` derives it from the declaration through
`specNamespacesJudgeCriteria`, which `makeGraders` also reads so the two cannot diverge.

A judge-family row carrying neither the overall name nor the declared prefix keeps its metric
verbatim rather than being given an invented criterion — a weaker identity that says less,
never a stronger one that says something else. The existing inline-versus-registered-judge
regression is unchanged and still green.

## Verification and limits

The review traced authorship, newly authoritative values, existing dependencies, composed
limits and sibling paths, adversarial cases, and transaction boundaries. Source inspection
covered PostgreSQL reservation/append lock ordering, but the SQL was not re-certified on a
real engine during this review.

The following existing suites were rerun against the reviewed implementation:

| Suite | Passed |
| --- | ---: |
| Domain measurement identity and campaign gate | 37 |
| Database campaign store unit tests | 66 |
| API oracle commit adapter tests | 2 |
| Total | 105 |

Additional temporary probes exercised R1, R2 and R4 as described above. R2 used the
in-memory adapter; R1 used a controlled comparison response. These probes were not added
as committed regression tests. R3 was verified by source-path inspection.

The full repository suite, real PostgreSQL, live GitHub and deployment E2E were not rerun.
The preceding implementation's recorded results remain historical evidence; they are not
new executions for this review. No implementation files were changed by the review.

## What the repairs were verified with

Each finding's counterexample was observed RED under a neutralization of its own repair,
and the failure text named the invariant rather than a fixture:

| Finding | Neutralization | Observed |
| --- | --- | --- |
| R1 | the caller-origin fallback restored on both sides | 5/5 red — "expected [{pr:7,…}] to deeply equal [{pr:7,…}]" on the compared commits |
| R2 | the attempt-ledger ending removed from `campaignStoppedAt` | 3/3 red — "expected 'continue' to be 'halt'" |
| R3 | the reservation removed from `ScorecardIngestService.ingest` | 4/5 red — "round requires an unreported evaluation reserved before both scorecards were submitted" |
| R4 | `measurementIdentityOf` restored to the two-prefix guess | 4/5 red — "expected 'x' to be 'judge:x'" |

`pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (from an emptied
`dist`) and every bespoke gate are green over the whole workspace.

Two gates were **already red on this branch before any of this** — verified by stashing these
changes and rebuilding contracts from that tree — and are repaired here rather than left
standing, because a gate that is red for somebody else's reason is a gate the next person
learns to read past:

- **`pnpm import-cycles`** reported an unbaselined `contracts/execution/grader.ts >
  execution/verdict-policy.ts` pair. `verdict-policy.ts` needed exactly one thing from
  `grader.ts` — the `MeasurementIdentity` type — while `grader.ts` needs the producer
  vocabulary from it. That is the shape the check's own header names, so the repair is the one
  it prescribes: the value both sides need belongs to neither, and
  `contracts/execution/measurement-identity.ts` now declares it and imports nothing but zod.
  `grader.ts` re-exports it, so the public surface is unchanged — `@everdict/contracts` exports
  only `.` and `./wire`, so no consumer could have deep-imported the old location.
- **`pnpm web-reach`** reported `/campaigns/:p/evidence-grants` and
  `/campaigns/:p/evidence-view` with no web caller and no decision. Both are genuinely not
  browser doors, and `evidence-view` is refused by construction: `resolveIdentity` mints an
  `evidenceGrant` principal only for an `Authorization: Bearer cpe_…` credential, and refuses
  that credential for every path but its own campaign's view. The grant door mints a scoped,
  expiring bearer token for a non-member delegate; a member already reads the round's evidence
  unredacted through `campaignRoundEvidence`, which `apps/web/src/features/drive-campaign` calls.
  Both are recorded in `DECIDED` with those reasons.

### What the review of these repairs found, and what it did not verify

The self-review's blast-radius pass found one defect in R4's own first draft, and it is worth
recording because the fix read as the conservative one. Leaving an unrecognised judge-family
row's metric verbatim looks weaker than inventing a criterion for it — and under the default
policy it is STRONGER: `{prefix: "judge:", segments: 2}` decides, while the canonical `judge`
metric with a criterion is diagnostic. A producer-submitted `judge:x` would have been promoted
from explaining to deciding. The off-prefix fallback is therefore left exactly as it was; only
the prefix SELECTION changed, and a regression test pins that such a row cannot decide a case.

Stated limits:

- **A reserved comparison reads as lost while its submission is in flight.** The reservation is
  written before the scorecard row (so a replay cannot dispatch twice), so between those two
  commits `spendOf` answers "lost" about an arm that is about to exist. Only a campaign whose
  budget is otherwise fully spent can be ended by it, and `settle` re-reads — but the honest
  close is one durable act across the two stores, which this change does not build.
- **`builtSourceFor` resolves a version by taking the newest `built` record that minted it**
  (`ORDER BY created_at DESC` then `.find`). That predates this change; what changed is that the
  oracle now DECIDES on it. Two records minting one version would be resolved by clock, which
  is the re-derivation L3 names.
- **An `environment` subject with a non-empty `oracleScope` now answers `unverifiable`** — the
  build ledger is keyed by harness instance version, and an environment campaign's baseline
  version is not one. No first-party procedure opens that combination.
- **`decision` and `settle` read one scorecard per bound arm of every unreported attempt.**
  Bounded by `budget.maxRounds` (≤ 1000, typically ≤ 20) and deduplicated by scorecard id, but
  it is a linear read where there was none.
- Not executed: real PostgreSQL (`trust-fast` — `attemptsForCampaign`'s statement has not been
  planned by an engine), live GitHub, `pnpm protocol-mutations`, and the deployment E2E.
