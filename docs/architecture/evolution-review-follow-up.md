---
kind: wiki
title: "Evolution identity and evidence authority"
status: current
updated: 2026-09-09
anchors: [packages/contracts/src/records/evolution-campaign.ts, packages/application-control/src/evolution/campaign-service.ts, packages/db/src/evolution/campaign-store.ts, apps/api/src/mcp.routes.ts]
---
# Evolution identity and evidence authority

Implements the review of main at `25814996b975a8b721272396b547854adde6fd6f`
(2026-09-08). The pure domain decisions and the durable adoption effect remain separate.

The [2026-09-09 follow-up review](evolution-review-2026-09-09.md) identified four gaps in
provenance, attempt-aware endings, first-party execution paths and criterion identity. All
four are now closed; that page carries each repair, its committed regression test and the
neutralization under which the test was observed red. The sections below are updated to
describe what is in force.

## Subject and oracle identity

`EvaluatedSubjectIdentity` is resolved once from each evaluated scorecard. Environment
subjects use the environment seal's version and document digest; harness and agent
subjects use the harness seal their execution actually consumed. Conflicting environment
seals refuse the round. Evidence, verdict and adoption proof carry the same identity.
No current registry read substitutes for missing historical seals.

Oracle inspection compares two commits in the same repository, including rename source
paths. Its receipt binds both SHAs, a normalized path-list digest, completeness and
`commitProvenance`. GitHub comparisons reaching the 300-file response limit are incomplete.
A moved PR head cannot change the commits inspected. Missing provenance or mismatched
receipts make the round non-comparable.

Both commits come from Everdict's own build ledger and from nothing else: the candidate's
from the build that minted the round's candidate version, the baseline's from the build that
minted the frame's `baselineVersion`, resolved in this campaign and up the `continues` chain.
The join to the evaluated arms is the instance version, which `logRound` has already checked
against each scorecard's own harness stamp. A scorecard's `origin` remains provenance on the
round and decides nothing here. A campaign whose baseline Everdict did not build therefore
cannot use an oracle scope — every round answers `unverifiable`, naming the missing side.

## Experiment-family attempts

Opening a continuation reserves its maximum round allocation alongside open siblings.
Closed members retain legacy rounds plus all evaluation attempts, including unreported
ones. PostgreSQL serializes allocation and creation with the same tenant advisory lock
used by evaluation reservations.

Before dispatch, `ScorecardService.submit` consumes a durable family attempt and binds
its server-minted scorecard id to one arm. Submit both arms with the same `campaignId`,
`requestId` and `candidateVersion`; `side` is `baseline` or `candidate`. Each arm must
request exactly the frozen scenarios and trial count. HTTP and SDK use
`campaignEvaluation`; MCP `run_scorecard` uses `campaign_evaluation`.

```json
{
  "campaignEvaluation": {
    "campaignId": "campaign-id",
    "requestId": "candidate-2-attempt-1",
    "candidateVersion": "2",
    "side": "candidate"
  },
  "trials": 20
}
```

One pair consumes one predeclared comparison, even when only one arm is submitted.
The request digest prevents substitution under an existing request id. A replay returns
the original scorecard without dispatching again. Failed, cancelled and unreported
attempts remain spent. Automatic execution retries and in-place rescore/retry operations
are refused for these scorecards; use a new reserved comparison for a new measurement.
Existing internal recovery may resume the same durable execution, but cannot grant a
fresh campaign comparison.

A crash between reservation and scorecard creation leaves the attempt spent. Replaying
an attempt whose scorecard is not durably readable returns a conflict and never
speculatively dispatches. This conservative handling also covers an unknown commit
outcome. No refund or automatic redispatch is inferred from an absent result.

`logRound` accepts only the exact pair belonging to an unreported reservation. The
append CAS, outbox and reported-round marker commit together. Evidence records the
attempt id. `POST /scorecards/ingest` takes the same `campaignEvaluation` block, so the
shadow-try loop can reserve through the door it uploads to; an ingested arm names its trials
by repetition, and a ragged upload is refused rather than accepted as a full arm. A
standalone evaluation or ingestion that reserved nothing still cannot become round evidence.

The campaign's endings are counted over that ledger rather than over the rounds. One owner
(`campaignSpendOf`) is read by the gate, by the write-side round refusal and by the
reservation door: a campaign ends on the budget when every comparison is spent AND none is
still outstanding, and a batch the store could not be read for keeps the campaign open rather
than closing it on a read that did not happen. Lost attempts stay spent; nothing refunds
budget. Historical rounds remain readable and count
against their family's budget; old overallocated families cannot execute beyond the
family limit through the reserved submission path. This is an authority boundary for
campaign evidence, not a claim that independent workspace administrators cannot perform
unrelated experiments.

## Adoption claims

A frame can declare `targetSatisfaction.minimumCandidateRate`. `improved` records
significant improvement; `satisfied` records meeting the observed success-rate threshold.
Both are required to flip a target when the threshold is declared. Improved targets
remain in subsequent feedback until the declared task is satisfied.

A separate `nonInferiority` policy declares `version: "hoeffding-v1"`, `margin`, `alpha`
and `minimumTrials`. Simultaneous bounded-Bernoulli intervals use a union bound over
both arms, all held-out cases and the preregistered family. Trials within each arm must
be independent Bernoulli observations. No independence between cases or arms is needed
for the union bound. A lower delta bound at least `-margin` establishes non-inferiority;
an upper bound below it establishes inferiority; insufficient samples or overlapping
bounds are inconclusive. The gate requires a matching policy digest and complete
per-case non-inferiority evidence before adoption under this policy.

Without this optional policy, zero held-out regressions continues to mean only **no
statistically significant regression was detected**. It is not proof of non-inferiority.
The target success threshold is an observed rate, not a population confidence bound.

## Measurements and historical policies

Scores carry structured producer kind/id, metric and optional criterion. The trusted
collector binds producer identity; producer-authored claims cannot choose authority.
Legacy label parsing is confined to the collection/legacy compatibility boundary.
Policy `2.0.0` matches and deduplicates structured coordinates, preserving separate
inline criteria and registered judges even when their display labels collide. Rescoring
and judgment-evidence attribution use the same ownership coordinates.

Deciders name every contributing measurement by original score-array index and canonical
score digest, together with the policy digest. These references are local to the case's
score vector. Optional `authorityOrder` and producer/criterion selectors permit explicit,
validated, sealed policy composition. Versions `1.0.0` and `1.1.0` remain unchanged;
historical records are not relabeled or silently interpreted under today's policy.
Observation assessments are retained on new structured scores; legacy normalization keeps
its original digest representation. Unmeasured/invalid scores remain distinct from measured failures. Partial evidence does
not automatically invalidate unrelated measurements.

## Delegate evidence capability

`POST /campaigns/:id/evidence-grants` and MCP `issue_campaign_evidence_grant` issue a
one-hour `cpe_` credential. The stored grant contains a digest-sealed, immutable view of
only non-held-out targets, their rates and structured diagnosis locations. It excludes
scorecard/run references, held-out rows and free-form learned/judge text.

The credential permits only `GET /campaigns/:id/evidence-view` and an MCP server exposing
only `get_campaign_evidence_view`. Each read rechecks expiry and the view digest. It cannot
switch workspaces, gain membership roles, access general readers or invoke mutation tools.

Create a sandbox with `profile` and HTTP `campaignId` / MCP `campaign_id` to use this
handoff. The service authors the brief from the allowed view and writes the scoped token
to `CAMPAIGN_EVIDENCE.json`, separately from the trace-recorded brief. Custom briefs and
persistent worlds are refused for this flow; the sandbox TTL is capped at one hour.
The orchestrator retains evaluation and adoption authority. The legacy round brief
remains an orchestrator read; it is not a credential grant. Independently supplied
workspace credentials or access to an external repository cannot be revoked by this
capability, and are outside its isolation claim.

## Verification

Regression scenarios cover environment evaluation through the production adoption
adapter, immutable commit comparison and renamed oracle paths, family creation and
attempt/append races on real PostgreSQL, submission replay and immutable campaign
results, unsatisfied improvements, inconclusive non-inferiority, measurement-name
collisions, historical policy replay, and HTTP/MCP/sandbox evidence capabilities.
No live GitHub or production deployment is part of these checks.
