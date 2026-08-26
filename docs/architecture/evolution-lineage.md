# Evolution lineage — ancestry, events, and the loop's own protocol

> Status: **design.** The optimization loop itself is landed and drilled: `agent-evolve` + `try_agent` +
> the trials statistics gate (Fisher exact + FDR + minDelta) completed a live campaign end-to-end, including
> an honest refusal on a saturated subset. What this document designs is the part that makes the loop's
> DECISIONS defensible over time: where a version's ancestry is recorded, how an evolution event reaches the
> subscription plane, what the judgment gets to read besides the agent's own story, and what turns the
> campaign's prose discipline into code. Four tracks, ordered by leverage. Written after a code recon dated
> 2026-08-26; every "exists today" claim below carries its address.

The product sells a defensible verdict. An optimization loop built on that product makes a second-order
claim: *this version is better than its ancestor, and here is the chain of evidence*. That claim has the
same failure mode the five protocol laws exist for — every noun it needs (origin, event, observation,
campaign) already exists somewhere in the codebase, and each is currently consumed as an annotation at
exactly one seam: the repin write drops the ancestor it holds in its hand, the `succeeds` predicate has no
emitter, the independent world observation never reaches the judgment, and the campaign's budget and
stop-conditions are prose in a skill body.

## What already holds (and this design must not restate)

- **The loop**: `packages/application-control/src/capability/first-party.ts` ships the `agent-evolve` skill
  with the campaign-issue convention; the adoption gate statistics live in the domain and were exercised
  live (0/15 → 15/15, p = 0.0079 at N = 5; and a p = 1.0 refusal on a saturated subset).
- **The lineage vocabulary**: `packages/contracts/src/knowledge/predicate.ts` declares `succeeds`
  (entity@vN → its predecessor), `compared_to` (diff), `born_from` (version → the intent that caused it).
  `born_from` is harvested today (`packages/domain/src/knowledge/harvest-specs.ts`); **`succeeds` and
  `compared_to` have no production emitter** — declared-but-dead predicates.
- **Origin storage**: registries persist a `CapabilityOrigin` per version *beside* the spec (jsonb column,
  stamped at insert, never rewritten — `packages/registry/src/pg-versioned-store.ts`), surfaced as
  `versionOrigins`. The contracts comment in `packages/contracts/src/records/capability-origin.ts` states
  the rule this design keeps: provenance is metadata beside the spec, never inside it.
- **The event plane**: domain transitions return `DomainFact[]`, `stampFacts` renders them, and the store
  write persists record + events in one transaction (`packages/application-control/src/platform-event/outbox.ts`;
  see `docs/architecture/event-plumbing.md`). Registry registrations already emit `harness.registered` via
  the `withRegisteredFact` decorator (`packages/application-control/src/platform-event/registry-facts.ts`).
- **World identity, half-landed**: `ExecutionManifest` era 2 carries `imageProvenance` — a three-arm union
  (`resolved` with observed digests / `unresolved{reason}` / `none`) populated from the driver's own handle
  (`packages/application-execution/src/run-case.ts`, `packages/contracts/src/execution/image-provenance.ts`).
  The Docker driver resolves digests by inspecting the container it actually started
  (`packages/drivers/src/docker.ts`); the K8s lane deliberately reports `unresolved{lane_cannot_report}`
  until it reads the kubelet's `imageID` (`packages/backends/src/orchestrators/k8s.ts` states this in
  place).
- **The observation**: `RepoEnvironment.sampleDelta` takes independent repo-diff samples during a run
  (`packages/environments/src/repo.ts`); `run-case` collects them as `EnvDelta[]`; `foldEnvDeltas` moves
  them into the replay recording and clears them off the persisted result
  (`packages/application-control/src/recording-manifest.ts`). **No grader, judge, or comparator reads
  them** — `GradeContext` (`packages/contracts/src/execution/grader.ts`) has no observation channel.
- **The regression watch**: issues already close on a proving scorecard and reopen as `regressed` when a
  later comparable scorecard drops (`packages/application-control/src/issue/regression-watch.ts`,
  `packages/contracts/src/records/tracker.ts`).
- **Budget primitives**: `TaskEnvelope.budgets` + `budgetExhausted` in
  `packages/contracts/src/records/ownership.ts`, the kernel's `budget_exhausted` stop reason, and the
  tenant-level `BudgetTracker` (`packages/domain/src/billing/budget.ts`). None of them are wired to a
  campaign.

## What must hold

1. **Ancestry is recorded by the writer that knows it** (L3). The repin service holds `base.version` at the
   moment it registers the successor; nothing downstream may re-derive lineage from semver adjacency or
   registration order — a version pinned from an older base has THAT base as its parent, which adjacency
   would silently misreport.
2. **An absent lineage is absent, not inferred** (L2). A version registered before this design has no
   recorded origin; the graph shows no `succeeds` edge for it. No backfill by guessing.
3. **An evolution event is a fact on the existing outbox, in the transaction that made it true** (L1/L4).
   No parallel event mechanism, no post-hoc emitter a crash can separate from the write.
4. **The judgment may read the world's own account, and "no observation" is a third value** (L2). A case
   with no `EnvDelta` samples is `unobserved` — never folded into "consistent".
5. **Adoption is a settlement** (L1/L4). The decision to promote a candidate references a frozen campaign
   frame by digest and the gate's recorded answer; a markdown log the agent edits is a journal, not an
   authority.

---

## Track A — lineage recorded at the write, events on the existing outbox

*The smallest track, and the one the user-visible question ("where did this version come from?") dies on
today.*

**The gap.** `repinHarnessImages` (`packages/application-control/src/harness/harness-pin-service.ts`)
computes the merge base, answers it to the caller in `RepinResult.base` — and then calls
`instances.register(tenant, next, subject)`, dropping it. The port already accepts what is being dropped:
`register(tenant, instance, createdBy?, teamId?, origin?)`
(`packages/application-control/src/ports/harness-instance-registry.ts`). Both repin callers (the HTTP route
and the MCP tool) pass no origin. Separately, `withRegisteredFact` emits `harness.registered` with only
`{id, version}` — its own comment already warns that a decorator forwarding only what it reads silently
drops the rest.

**The design.**

- `repinHarnessImages` gains a **required** `via: CapabilityOrigin["via"]` parameter (plus the optional
  agent-attribution fields the MCP caller has). The service — the only code that knows the merge base —
  constructs the origin itself: `from = {type: "harness", id, version: base.version}`, `note` carrying the
  pin summary. Callers cannot supply `from`; a caller-supplied ancestor would be a second spelling of a
  fact the service owns. Optional-parameter shapes are rejected on the record: an optional origin is how
  this gap was born (the parameter existed and no caller passed it).
- `withRegisteredFact` forwards all five `register` arguments and the fact payload gains the origin
  summary: `payload: {id, version, origin?: {via, from?}}`. **No new event kind.** A repin *is* a
  registration; `harness.repinned` beside `harness.registered` would be two spellings of one birth, and
  every consumer (product watch-series, subscriptions, the agent trigger grammar) already listens to
  `registered`. What was missing from the event was not a kind but a payload that says *from what*.
- The registry-spec harvesters emit `succeeds`: for every version whose stored origin's `from` names the
  SAME family (`type: "harness"`, same id), emit `harness@vN -[succeeds]-> harness@vFrom` with
  `edgeAttrs: {via}`. Versions without a recorded same-family origin get **no** edge (rule 2 above). The
  harvesters already receive `versionOrigins` for `born_from`; this is the same read, second predicate.
  Semver-adjacency emission is explicitly rejected — it is identity re-derived from rendered output, and it
  lies precisely when lineage is interesting (a fix re-pinned from `1.2.0` while `1.3.0` exists).
- The same change applies to the agent registry (`save_agent` adoption) and dataset derivation where an
  origin is already recorded — one predicate, every family whose registry stores `CapabilityOrigin`.

**Checklist answers.** External effect: none new (a registry write and an outbox fact already exist — this
track moves values that are already in hand onto them). Unknown read: a version with no origin harvests no
edge. Escape hatch deleted: the 3-argument `register` call shape disappears from the repin path in the same
change; the decorator's partial forwarding is replaced, and its warning comment retired with it.

**Verification.** Counterexample RED first: repin a harness, reindex, assert the graph answers
`succeeds(next) = base` — red today because no edge exists. A second counterexample pins from an OLD base
with a newer version present, and asserts the edge names the old base (kills any adjacency implementation).
Fact test: the registered fact's payload carries `origin.from` in the same store write (crash between write
and emit must be impossible by construction — assert via the outbox row, not the live push). Mutation rung:
neutralize the origin construction in the repin service; the suite must go red.

## Track B — the world identity a comparison stands on (the producer the reader was waiting for)

**Correction (2026-08-26).** The first draft of this track claimed the diff had no reader — that a
comparison would happily treat a `resolved` run against an `unresolved` one as significant. That was wrong:
the `execution_world` identity axis already reads `imageProvenanceOf` from both sides' results
(`packages/domain/src/scorecard/experiment-identity.ts`), answers `unverified{unresolved}` when either side
cannot pin its bytes, `confound` when resolved digests differ, covers the enforced box and the verifier
receipt — and the gate refuses an unverified axis unless the policy records `allowUnverifiedIdentity`
(`packages/domain/src/scorecard/gate.ts`). The reader landed with the world-axis waves; what remained was a
**producer**: the K8s lane could not name an unpinned tag (`unresolved{lane_cannot_report}`), so every
`:latest`-style run on that lane carried an unverifiable world and the axis degraded exactly where drift is
most likely.

**The design (landed with this track).**

- The K8s lane reads `status.containerStatuses[].imageID` — the kubelet's own account of the pulled digest,
  an observation rather than an inference — before the dispatch reclaims the Job, at the point the code
  comment had reserved for it. One extractor owns the imageID formats (`observedPlacementImage`,
  `packages/domain/src/image/image-provenance.ts`): no match or no digest answers `undefined`, and the merge
  falls back to the honest reference reading — never a fabricated resolution.
- `mergePlacedImage` takes the observation as a **required** parameter
  (`packages/backends/src/orchestrators/placement-image.ts`): `undefined` states "this lane has no
  readback" explicitly. Nomad passes it deliberately — its allocation driver state is a follow-up — so an
  unpinned tag there stays honestly unresolved, consumed by the axis as `unverified`.
- The **campaign adoption gate (Track D) refuses** an `unverified` world axis rather than degrading — an
  optimization verdict on unresolved world identity is exactly the claim we sell against; a recorded waiver
  is the only bypass and it appears in the gate answer.

**Verification.** Counterexample drives the production dispatch with a fake cluster: a placed `:latest`
whose pod reports a `docker-pullable://…@sha256:…` imageID resolves to that digest stamped
`by: "orchestrator"` (RED before the read existed: `expected 'unresolved' to be 'resolved'`), and an
unavailable observation keeps `unresolved{lane_cannot_report}`. The extractor's format variants and its
refuse-to-guess arm are pinned in the domain suite. Live: a kind-cluster case from an unpinned tag,
asserting the manifest carries the registry digest.

## Track C — the observation delivered to the judgment

*The heaviest track; last on purpose.*

> Status: **landed, follow-through included.** `GradeContext.observations` is a REQUIRED channel
> (`sampled{deltas}` | `unobserved{unsupported | sampling_failed | no_environment}`) — the compiler
> enumerated every construction site, and each states what it knows; `runCase` feeds the sampled series at
> grading time, and the judge's prompt ALWAYS carries the section, so an absent channel is a stated fact
> rather than a missing paragraph. The follow-through: the channel is SEALED into the trace
> (`observationTraceEvents` / `observationsFromTrace` — one writer, one reader; capped sample events plus a
> channel marker), so a re-score and the deferred scoring paths (collect / re-score / ingest) reconstruct
> the SAME observations the in-run judges saw, and a pre-channel or foreign trace is honestly
> `unobserved{no_environment}`. The environment sampler now THROWS on a failed sample (the shell no longer
> hides git's own failures) and the recorder counts outcomes, so a run whose every sample failed is
> `sampling_failed` — never a calmer-looking world. The judge's verdict contract asks for
> `observation_consistency` exactly when the channel sampled, parsed onto
> `JudgeVerdict.observationConsistency` and folded into the overall judge score's durable `detail` (prose,
> deliberately — nothing may re-derive a decision from rendered text; a gate weighing it needs the field on
> the contract and is the remaining consumer). The channel is also UNFORGEABLE from outside the sealer
> (review wave B): the reserved `platform_observation_*` vocabulary is stripped where untrusted bytes enter
> a trace (the harness drain, the in-job platform pull, the push ingest), a foreign span spelling it is
> demoted to a structural span at the mapper, and the reader takes the FIRST marker with only the samples
> before it — so bytes appended after the seal can neither fabricate nor suppress the sampled account.
> Nomad image readback was investigated and settled: the allocation API exposes no structured pulled-digest
> field, so the reference reading stays that lane's honest answer and a digest pin remains the user's
> escape.

**The gap.** `EnvDelta[]` is an independent observation of the world (sampled by the environment, not
reported by the agent), and today its terminal consumer is the replay recording — it is cleared off the
persisted result and no judgment input carries it. The judge grades the agent's trace: the agent's own
story. Claim-vs-observation divergence — "the trace says tests were fixed; the repo diff shows only the
test file was deleted" — is computable from data we already collect and is computed nowhere.

**The design.**

- The deltas become part of the sealed evidence rather than only the replay: the evidence payload the
  judgment references carries the observation samples (or a content-addressed ref to them), so a re-score
  reads the same observations the original judgment saw (L4 — today they live only in the recording, which
  is not what the judge is sealed over).
- `GradeContext` gains an explicit **observation channel**: `observations` as a discriminated value —
  `sampled{deltas}` | `unobserved{reason}` — never a bare optional array. An environment with no
  `sampleDelta` (browser, os-use, prompt) is `unobserved{unsupported}`; a repo env whose sampling failed is
  `unobserved{sampling_failed}`; both are distinct from `sampled{[]}` ("observed: nothing changed"), which
  is a real and meaningful answer. Judges receive it in the prompt contract; code graders may match on it.
- A pure comparator in `@everdict/domain` — claim extraction is judge work (semantics), but the *frame* is
  kernel work: given the trace's terminal claims and the observation value, the judgment's verdict carries
  an `observationConsistency` field: `consistent | divergent{quote, delta}` | `unobserved{reason}`. The
  campaign gate (Track D) and the release gate may then weigh divergence; nothing folds `unobserved` into
  either other arm.

**What this is not.** Not an attempt to structurally parse agent claims in v1 — the judge already reads the
trace; giving it the world's own account and requiring a three-valued answer is the increment. A
deterministic differ over structured claims is a later wave if judge-reported divergence proves noisy.

**Verification.** Counterexample: a scripted harness that *claims* an edit it never made; a code judge over
the observation channel answers `divergent`; RED while the channel is absent. The three-value law:
`unobserved` asserted ≠ `sampled{[]}` — a mutation that folds them must go red. Evidence sealing: re-score
of a sealed case reads identical observation bytes (digest equality), the `scoring-revision` divergence
machinery extended to cover them.

## Track D — the campaign is a settlement, the guards are code

> Status: **landed** (record + stores + pure gate + service + both transports + facts). `save_agent` now
> carries the origin declaration too (fromIssue for a first version; a BUMP records the base it succeeds —
> the service knows the ancestor, and a caller restating its own family is REFUSED at every register door:
> `capabilityOriginFor` takes the capability's `self` and rejects a same-family declared `from`, review
> wave C), and the agent registry's list forwards `versionOrigins` all the way to the wire and the web
> schema, so the adopted version's lineage reaches the graph on both families. The settlement itself was
> review-hardened (wave A): the close CAS fences the ROUNDS COUNT as well as the state (a gate answer
> computed over N rounds may not close a record holding N+1 — settle-vs-append race certified on real
> Postgres, TRUST-183), `logRound` refuses identity drift (the candidate scorecard must have evaluated the
> frame's subject at the declared version), `verdictOf` enforces the frame (scenario set, trials floor,
> judge set — drift is non-comparable with the reason) and records CONFOUNDS (axes VERIFIED different,
> never waivable) as their own verdict field, and the frozen significance + the caller's team ceiling ride
> the diffSnapshot dependency so the identity checks read the documents the significance was computed
> from. Derivation writes also preserve the owning team (wave C: re-pin reads the base's team through the
> now-REQUIRED `teamOfVersion` port method; the agent bump reads its entity's team), and the MCP pin tool
> authorizes against the entity's team like the route. Still open on this track: a hard refusal of a
> campaign-candidate save that arrives WITHOUT the gate's `adopt` answer (today the coupling is the settle
> tool's contract, not a guard).

**The gap.** Everything the `agent-evolve` skill mandates — frozen frame, N ≥ 3 trials, budget cap stated
up front, stop after 3 rejected rounds, adoption only on significant-improvement-zero-regressions — is
prose. There is no campaign record, no round counter, no cap primitive; the campaign is an ordinary issue
holding a markdown log the agent itself edits. A decision (adoption) currently rests on a journal.

**The design.**

- A small **campaign record** owned by `application-control` (store port + in-memory/Pg impls + numbered
  migration; API + MCP slice with BFF↔MCP parity): an immutable **frame** (target agent/harness family,
  scenario ids with held-out marked, judges, N, budget cap, adoption threshold — frozen at open, referenced
  by digest thereafter) and append-only **rounds** (`{hypothesis, candidateVersion, baselineScorecardId,
  candidateScorecardId, diffVerdict, decision}`). The issue stays — as the narrative journal and the
  intent-stratum hub the graph already centers on — and the record references it. What the record adds is
  exactly what an issue cannot hold: frozen bytes and a derived state.
- A **pure adoption gate** in `@everdict/domain`: `(frame, rounds) → adopt{version, provingScorecardId}
  | continue | halt{no_improvement | budget_exhausted | comparability}` — total, no I/O, consecutive-
  rejected and budget-spent derived from the rounds rather than kept as mutable counters. It composes the
  Track B world-identity refusal and (once landed) the Track C divergence weight. `TaskEnvelope.budgets` /
  `budgetExhausted` are the budget vocabulary; the tenant `BudgetTracker` still meters spend independently.
- **Authority before effect**: `save_agent` / registry adoption *for a campaign candidate* requires the
  gate's `adopt` answer (carried, not re-derived), and the HITL approver approves that answer — the human
  sees what the gate concluded, not a summary the loop wrote about itself. The adopted version's origin
  (`from: {type: "issue", id: campaignIssueId}`) closes the loop into Track A's lineage: `born_from` the
  campaign's issue, `succeeds` its base version — ancestry and intent both queryable.
- The harvester emits `compared_to` from rounds (`candidateScorecard -[compared_to]-> baselineScorecard`,
  `edgeAttrs: {verdict}`) — the durable decision is the source, never the read-time diff endpoint.

**Checklist answers.** Effect: registry writes and spend. Proof before effect: the gate answer + frame
digest are parameters of adoption, not hopes. Unknown: a round whose scorecard cannot be read is
`halt{comparability}`, never skipped. Escape hatch: the skill's prose keeps teaching *how to think*, but
its numeric mandates move into the frame; a campaign without a record cannot reach the adoption tool.

**Verification.** Counterexamples RED first: adoption attempted without a gate answer → refused; a 4th
round after 3 rejections → `halt{no_improvement}`; budget arithmetic over rounds crossing the frame's cap →
`halt{budget_exhausted}`; a frame edit after open → refused (digest mismatch). Mutation rungs on the gate's
three halt arms. The live drill (the existing campaign recipe) re-run through the record — the same
statistics, now with the settlement.

---

## Rollout order

**A → B → D → C.** A is wiring plus one harvester read — smallest change, retires two known annotation
defects (the dropped `base`, the partial decorator), and every later track writes into the lineage it
establishes. B's reader half is required before D can refuse honestly (a campaign gate that cannot see
world identity certifies drift as improvement). D turns the already-drilled loop into a settlement. C is
the deepest evidence-semantics change and benefits from D existing — divergence has a consumer on day one.

The 2026-08-18 review of this area recommended world-identity first; half of that track has since shipped
(era-2 provenance, Docker digests). The order above is that recommendation updated for what landed: what
remains of B is its *reader*, and A now unblocks the most for the least.

## Deliberately not

- **No new event kinds** for evolution (Track A) — payload enrichment of the births that already emit.
- **No semver-derived lineage, no backfill** — recorded origin or nothing.
- **No structured claim parser in Track C v1** — the judge answers over the observation channel first.
- **No campaign workflow engine** — the record is a frame + rounds + a pure gate; orchestration stays in
  the agent loop that already runs it.
- **No signing / transparency log** — multi-party trust (a customer submitting verdicts to a third party)
  is the trigger for that conversation, per the 2026-08-18 standards review.

## Related

- `docs/architecture/knowledge-graph.md` — the lineage predicates, the intent stratum, harvest mechanics.
- `docs/architecture/event-plumbing.md` — the outbox, consumers, subscriptions.
- `docs/tracker.md` — issues as the intent hub; resolution-as-baseline; the regression watch.
- Rule `protocol` — the five laws this design is an application of.
- `packages/contracts/src/records/capability-origin.ts` — provenance beside the spec, never inside it.
