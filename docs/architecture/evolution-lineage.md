---
kind: wiki
title: "Evolution lineage — ancestry, events, and the loop's own protocol"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/knowledge/harvest-specs.ts, packages/application-control/src/harness/harness-pin-service.ts, packages/domain/src/image/image-provenance.ts, packages/domain/src/observation/observation-trace.ts, packages/domain/src/evolution/campaign-gate.ts]
---
# Evolution lineage — ancestry, events, and the loop's own protocol

The product sells a defensible verdict. An optimization loop built on it makes a second-order claim: *this
version is better than its ancestor, and here is the chain of evidence*. That claim fails the way the five
protocol laws describe — every noun it needs (origin, event, observation, campaign) existed in the codebase and
was consumed as an annotation at one seam: the repin write dropped the ancestor it held, the `succeeds`
predicate had no emitter, the independent world observation never reached the judgment, and the campaign's
budget and stop conditions were prose in a skill body.

Four tracks closed those seams. All four are landed; what is still open is listed at the end.

## What must hold

1. **Ancestry is recorded by the writer that knows it** (L3). Nothing downstream re-derives lineage from semver
   adjacency or registration order — a version pinned from an older base has THAT base as its parent.
2. **An absent lineage is absent, not inferred** (L2). A version registered with no recorded same-family
   origin has no `succeeds` edge. No backfill by guessing.
3. **A lineage event is a fact on the existing outbox, in the transaction that made it true** (L1/L4).
4. **The judgment may read the world's own account, and "no observation" is a third value** (L2).
5. **Adoption is a settlement** (L1/L4). Promoting a candidate references a frozen campaign frame by digest
   and the gate's recorded answer, never a log the agent edits.

## Track A — lineage recorded at the write

- `repinHarnessImages` (`packages/application-control/src/harness/harness-pin-service.ts`) takes a required
  `RepinOrigin` (the channel and attribution) and stamps `from = {type: "harness", id, version: base.version}`
  itself — callers cannot supply the ancestor. Its callers are the HTTP route, the MCP tool and the campaign
  build composition (`apps/api/src/composition/campaign-build.ts`). Counterexample:
  `packages/registry/src/harness/harness-pin-lineage.counterexample.test.ts`.
- `withRegisteredFact` (`packages/application-control/src/platform-event/registry-facts.ts`) forwards the whole
  `register` call, and the `*.registered` fact payload carries `origin: {via, from?}`. **No new event kind**: a
  repin is a registration, and every consumer already listens to `registered`.
- The spec harvester (`common` in `packages/domain/src/knowledge/harvest-specs.ts`) reads the stored origin:
  a `from` naming the spec's own family with a version becomes `succeeds`; any other `from` becomes `born_from`.
  Registries persist the origin beside the spec (`packages/registry/src/pg-versioned-store.ts`, surfaced as
  `versionOrigins`), per the rule in `packages/contracts/src/records/capability-origin.ts`.
- A caller may not declare a same-family `from`: `capabilityOriginFor` (`apps/api/src/api/capability-origin.ts`)
  takes the capability's `self` and refuses it at every register door. `save_agent` records the declared issue
  on a first version and the base on a bump; the agent list forwards `versionOrigins` to the wire and the web
  schema.

## Track B — the world identity a comparison stands on

- The `execution_world` identity axis (`packages/domain/src/scorecard/experiment-identity.ts`) reads
  `imageProvenanceOf` from both results: `unverified` when either side cannot pin its bytes, `confound` when
  resolved digests differ. The scorecard gate refuses an unverified axis unless the policy records
  `allowUnverifiedIdentity` (`packages/domain/src/scorecard/gate.ts`).
- The K8s lane reads `status.containerStatuses[].imageID` before the Job is reclaimed
  (`packages/backends/src/orchestrators/k8s.ts`). One extractor owns the imageID formats
  (`observedPlacementImage`, `packages/domain/src/image/image-provenance.ts`); no match answers `undefined`,
  never a fabricated resolution.
- `mergePlacedImage` (`packages/backends/src/orchestrators/placement-image.ts`) takes the observation as a
  required parameter. Nomad passes `undefined`, so an unpinned tag on that lane stays
  `unresolved{lane_cannot_report}`; a digest pin is the user's escape.
- The campaign gate refuses an unverified identity axis (`halt` reason `identity_unverified`) unless the frame
  recorded `allowUnverifiedIdentity` at open; a waived axis is named in the adopt answer's `waivedAxes`.

## Track C — the observation delivered to the judgment

- `GradeContext.observations` is a required `CaseObservations` (`packages/contracts/src/execution/grader.ts`):
  `sampled{deltas}` | `unobserved{unsupported | sampling_failed | no_environment}`. `runCase` feeds the sampled
  series at grading time, and the judge prompt always carries the section. The repo environment's sampler
  throws on a failed sample, so a run whose every sample failed is `sampling_failed`.
- The channel is sealed into the trace by one writer and one reader (`observationTraceEvents` /
  `observationsFromTrace`, `packages/domain/src/observation/observation-trace.ts`), so re-score and the deferred
  scoring paths reconstruct what the in-run judges saw; a trace with no marker is `unobserved{no_environment}`.
  The reserved observation vocabulary is stripped where untrusted bytes enter a trace, and the reader takes the
  FIRST marker with only the samples before it.
- The judge answers `observationConsistency` (`consistent | divergent | unclear`, `packages/graders/src/judge.ts`)
  when the channel sampled. It lands on the stored score twice: as prose in `detail` and structured as
  `Score.observationAssessment`.
- A campaign round counts the candidate side's assessments into `verdict.observations`
  (`divergent`, `unclear`, `assessed`, `eligible`), and the campaign gate weighs them through the frame's
  `observationPolicy`: divergence refuses adoption unless `allowDivergent`, `maxUnclear` bounds the unclear
  count, and `minimumCoverage` refuses a round whose coverage is absent or too low.
- There is no structured claim parser: the judge reads the trace and the observation and answers.

## Track D — the campaign is a settlement

- **The record.** `packages/contracts/src/records/evolution-campaign.ts`: an immutable frame (subject, scenarios
  with held-out marked, judges, trials, budget, significance, policies) sealed as `frameDigest` at open, and
  append-only rounds whose verdict the service derives. Stores in `packages/db/src/evolution/campaign-store.ts`;
  both transports in `apps/api/src/api/campaign/campaign.routes.ts` and `campaign.mcp.ts`.
- **The gate.** `campaignAdoption` (`packages/domain/src/evolution/campaign-gate.ts`) is pure: `adopt` |
  `continue{roundsLeft, consecutiveRejected}` | `halt{no_improvement | budget_exhausted | identity_unverified |
  exam_inert}`. Endings are derived from the rounds and the attempt ledger, never kept as mutable counters (see
  [the identity and evidence authority page](evolution-review-follow-up.md) for the ledger).
- **The write side.** `logRound` refuses identity drift (the candidate scorecard must have evaluated the frame's
  subject at the declared version), enforces the frame (scenario set, trials floor, judge set — read from the
  scoring ledger's current revision), records verified confounds as their own field, and refuses a round past
  the budget or the rejected streak, race-safe on the append CAS. The close CAS fences the rounds count as
  well as the state (`apps/api/src/trust/campaign-append-cas.trust.test.ts`, TRUST-183).
- **Adoption is an authorization somebody spends.** An adopted close writes a durable `AdoptionOperation` in the
  same statement. `GET /campaigns/:id/adoption` / `campaign_adoption` read it; `POST /campaigns/:id/adopt` /
  `adopt_campaign_candidate` present the spec, which is compared against the stored proof and digested before
  the registry write (`apps/api/src/composition/campaign-adoption.ts`). The gate refuses `adopt` when the round
  sealed no spec digest unless the frame recorded `allowLabelOnlyAdoption`. The adopted version is registered
  with `from: {type: "issue"}`, so it is `born_from` the campaign's issue.
- **Completion.** The join between a spent adoption and the issue resolution is symmetric: an E1 consumer over
  `issue.status_changed` (`packages/application-control/src/evolution/adoption-completion-watch.ts`) and the
  registration path both perform it. `AdoptionCompletionReconciler` owns the case where neither lands; its
  worklist is due-first (`next_attempt_at`, migration `0201`), and a deferral the statement did not move is
  counted as `undeferred`.
- A campaign no longer carries an owning team; that axis went with the team (migrations `0211`/`0212`).
- The code loop — a delegated coding agent changes the harness repository, Everdict builds the image, the round
  pins it — is [code-evolution-loop.md](code-evolution-loop.md); its record rung here is
  `verdict.candidateSource`.

## Still open

- **`compared_to` has no emitter.** The predicate is declared (`packages/contracts/src/knowledge/predicate.ts`);
  no harvester turns a round into `candidateScorecard -[compared_to]-> baselineScorecard`.
- **Ingested scorecards seal no manifest and resolve no registry document.** A loop running on ingested traces
  needs both `allowUnverifiedIdentity` and `allowLabelOnlyAdoption` on the frame; the stronger answer is for
  ingest to seal the digest of the document it evaluated and the world it ran in.
- **Nomad has no image readback** (Track B).

## Deliberately not

- **No new event kinds for lineage** — payload enrichment of the registrations that already emit.
- **No semver-derived lineage, no backfill** — recorded origin or nothing.
- **No structured claim parser** — the judge answers over the observation channel.
- **No campaign workflow engine** — the record is a frame, rounds and a pure gate; orchestration stays in the
  agent loop.
- **No signing or transparency log** — multi-party trust (a customer submitting verdicts to a third party) is
  the trigger for that conversation.

## Related

- `docs/architecture/knowledge-graph.md` — the lineage predicates, the intent stratum, harvest mechanics.
- `docs/architecture/event-plumbing.md` — the outbox, consumers, subscriptions.
- `docs/tracker.md` — issues as the intent hub; resolution-as-baseline; the regression watch.
- Rule `protocol` — the five laws this design applies.
