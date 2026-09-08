# Evolution identity and evidence follow-up

This change responds to the review of main at
`25814996b975a8b721272396b547854adde6fd6f` (2026-09-08).

## Implemented contracts

- Resolve an `EvaluatedSubjectIdentity` once from each evaluated scorecard. Environment
  subjects use their environment seal's version and document digest; harness and agent
  subjects retain the harness seal used by their existing execution path. Conflicting
  environment seals refuse the round. Evidence records that identity, and verdicts and
  adoption proofs use its digest. A missing digest remains unverified; no current
  registry document is substituted for an old seal.
- Oracle reads require both evaluated commit SHAs in the same repository. The GitHub
  adapter compares those immutable SHAs, includes rename source paths, and refuses to
  claim completeness at the 300-file comparison limit. A receipt records repository,
  both SHAs, normalized path-list digest, and completeness. Missing provenance or a
  receipt for different commits makes the round non-comparable. Existing unscoped
  frames and stored historical rounds retain their meaning.
- Creating a continuation reserves its full round allocation alongside allocations
  of all open siblings and descendants. Closed members count their logged rounds.
  PostgreSQL serializes the capacity check and creation (including its outbox) in one
  transaction using a tenant-scoped advisory lock. Round append also enforces the
  campaign's allocation. Existing overallocated families cannot open more successors;
  this change does not retroactively invalidate their frames or rounds.
- A frame may declare `targetSatisfaction.minimumCandidateRate`. A target must then
  both improve significantly and reach that candidate pass rate to count as flipped.
  `improved` and `satisfied` are recorded separately. Without the new declaration,
  historical significant-improvement semantics remain. This threshold concerns the
  observed pass rate; it is not a confidence bound on the population success rate.
- Delegation briefs retain target traces after improvement and omit the full candidate
  scorecard reference. Learned text remains proposal advice and cannot authorize adoption.

## Remaining boundaries

Campaign allocation is **not** an evaluation-attempt ledger. Standalone evaluation and
scorecard ingestion can still happen before `logRound`, and a caller can choose which
completed scorecards to report. Closing an open campaign releases its unlogged allocation.
Consequently the allocation fix prevents sibling campaign overcommit; it does not certify
that every actual held-out evaluation was counted, nor repair pre-existing overcommit.

The next boundary needs a durable `ExperimentFamily` and an evaluation reservation minted
before dispatch, with one attempt identifier bound to the resulting scorecards. Dispatch,
ingestion, retries, cancellation, and round append must all consume that same identifier.
Unreported and failed dispatched attempts must remain spent; retrying an idempotent request
must reuse its reservation. Adding a reservation only at `logRound` would still be too late.

`heldOut.regressions === 0` continues to mean **no statistically significant regression was
detected**. It is not proof of non-inferiority. A separate, versioned adoption policy must
specify a tolerable degradation margin, minimum evidence, confidence procedure, and an
inconclusive outcome before stronger claims are exposed.

Structured producer/metric/criterion identities and stable measurement references need a
versioned migration of score producers, normalization, deduplication, verdict policies, and
stored bases. Adding fields to the writer alone would leave authority at the old string
parser. The existing sealed authority hierarchy and historical-policy resolution therefore
remain unchanged in this change.

Removing the scorecard reference narrows the brief's advertised capabilities; it does not
revoke the delegate's independent credentials. End-to-end held-out isolation still requires
a target-only evidence authorization surface and enforcement on every referenced run read.

## Verification

Regression coverage includes environment evaluation through the production adoption adapter,
a changed PR head receipt, immutable GitHub comparison and renamed oracle paths, concurrent
family creation in memory and real PostgreSQL, target improvement below a success threshold,
and brief reference filtering. No live GitHub request or production deployment is required
by these tests.
