# Trust certification (the nightly invariant suite)

Everdict's product is a **verdict**. Every other kind of bug costs a user time; a bug in the verdict costs
them the thing they came for, and does it silently — a number that looks like every other number, a green
light that looks like every other green light. The trust suite exists for exactly that class.

It certifies **invariants**, not features. Each scenario states a sentence that must never stop being true,
and all of them are variations on one:

> **No failure becomes a normal number or a normal verdict.**

A dead grader is not a zero. A batch that ran 4 of 5 cases is not a batch that passed. A policy nobody can
restore is not today's policy. A replica that stopped answering is not a replica that died. An exhausted
budget is not a budget.

- **Where it runs**: `.github/workflows/trust-nightly.yml` — nightly at 03:00 UTC, plus `workflow_dispatch`.
  It is deliberately **not** part of the push gate (`ci.yml`); see [Why it is not in ci.yml](#why-it-is-not-in-ciyml).
- **What runs it**: `scripts/trust/trust-suite.mjs`.
- **What it runs**: every `*.trust.test.ts` file in the repo, colocated with its subject.

## The one rule that makes the certification worth anything

**A skipped scenario is a FAILED certification.**

Every trust file skips itself when its infrastructure is absent — correct for a developer running one
scenario on a laptop, and catastrophic as a nightly default, because "0 failures out of 0 executed" would
print PASS. So `trust-suite.mjs` parses vitest's JSON report, counts what actually executed, and refuses to
certify if anything was skipped or if the scenario set is empty. It also refuses to start without a database
rather than running the non-Pg scenarios and reporting green.

A suite that certifies nothing must never look like a suite that certified everything. That is the same
failure mode the suite exists to catch, so the runner is held to it too.

## What a scenario's wording may claim

A scenario earns **production wording** only when it crosses a production seam. Several here drive a pure
decision function — which is the right place to certify a rule that many paths must obey — and their rows say
so explicitly (**DECISION-level**), because a description that says "every re-resolution refuses" while the
test calls one helper is a claim about wiring that nothing checked. That gap is exactly how an asymmetry
survived a round: resume verified the harness and the Temporal plan verified the dataset, each covering the
half the other missed, and both looked handled.

## The scenarios

| ID | Invariant | Where |
| --- | --- | --- |
| TRUST-01 | A grader that dies produces an **unmeasured** score with no `value` field — the batch mean stays the mean of what was measured | `packages/job-runner/src/grader-failure.trust.test.ts` |
| TRUST-02 | A candidate that ran fewer cases than the baseline is **`blocked_missing`**, never a pass | `apps/api/src/trust/release-gate.trust.test.ts` |
| TRUST-03 | A stamped verdict policy that cannot be restored (or that disagrees with the baseline's) is **`not_comparable`**, and there is nothing to override | `apps/api/src/trust/release-gate.trust.test.ts` |
| TRUST-04 | A grader that returns `NaN` produces an **invalid** score, aggregated nowhere | `packages/job-runner/src/grader-failure.trust.test.ts` |
| TRUST-07 | A workspace quota is **fleet-wide AND race-proof**: two scheduler replicas hand it out once — including when both burst in the same instant against a stale snapshot (the atomic admission permit, mig 0139) | `apps/api/src/trust/fleet-admission.trust.test.ts` |
| TRUST-08 | Exactly one leader per role; a clean shutdown hands the lease back at once, a crash is replaced only when the lease expires | `apps/api/src/trust/leader-election.trust.test.ts` |
| TRUST-09 | Boot recovery reclaims a **dead** replica's batch and leaves a live one's alone; an unreadable heartbeat set reclaims nothing | `apps/api/src/trust/replica-recovery.trust.test.ts` |
| TRUST-10 | Caused work draws from its delegator's envelope — an exhausted cap refuses (402), runaway depth refuses (429), a forged causer refuses (400) | `apps/api/src/trust/envelope-budget.trust.test.ts` |
| TRUST-11 | A verifier checkpoint filed by the actor that executed the run is refused; a "fact" citing evidence that does not exist is refused | `apps/api/src/trust/self-verification.trust.test.ts` |
| TRUST-12 | The same evidence has **one verdict**: a scorecard child's served run verdict derives under its PARENT's stamped/composed policy — run detail ≡ case dialog, across the real Pg row mappers | `apps/api/src/trust/verdict-consistency.trust.test.ts` |
| TRUST-13 | The release-regression unit is the **case verdict in every mode**: trials=1 and trials>1 gate on the same claim; a diagnostic metric flip blocks in neither; one collapsed case counts once | `packages/domain/src/scorecard/regression-unit.trust.test.ts` |
| TRUST-14 | An **evidence-only read scope means what it says**: the kernel refuses a read outside `scope.reads` | `packages/agent-runtime/src/kernel/envelope-consent.trust.test.ts` |
| TRUST-15 | readOnly is not safe-without-consent: a read with declared **external egress** consults the permission hook in every mode | `packages/agent-runtime/src/kernel/envelope-consent.trust.test.ts` |
| TRUST-16 | A budget halt **suspends** (never completed), and resumability is claimed only when the handoff actually landed (`handoff published|failed|absent` on the fact) | `apps/agent/src/suspended-halt.trust.test.ts` |
| TRUST-17 | One policy document has **one identity across digest eras**: an FNV-era stamp and a sha256 stamp of the same document resolve, compare equal, and never read as a mismatch | `packages/domain/src/scorecard/policy-era.trust.test.ts` |
| TRUST-18 | A **silently-unemitted score row cannot gate green**: 99 of 100 vanished measurements is blocked_missing, never "0 regressions" | `packages/domain/src/scorecard/regression-unit.trust.test.ts` |
| TRUST-19 | **Permit conservation**: `in_flight` equals the live permit rows at every step — a lost-response retry with the same permit id claims the counter at most once, a double release decrements nothing, freed quota is really free | `apps/api/src/trust/fleet-admission.trust.test.ts` |
| TRUST-20 | **The permit is a lease, not a timestamp**: the reap frees a lapsed lease (a dead holder heals — throttling) and never a renewed one (a healthy long run is never reaped — the quota-inflation direction stays closed) | `apps/api/src/trust/fleet-admission.trust.test.ts` |
| TRUST-21 | **A confounded pair cannot gate green**: a verified held-constant difference (dataset content / grading plan / judge set, read from the sealed manifests) refuses as not_comparable; the only way through is a RECORDED acknowledgment (`allowConfounds`) | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-22 | **A refusal carries no verdict numbers**: a not_comparable decision (confound / unresolvable stamp) presents structure only — no regression counts nobody had the right to derive, and no transitions minted upstream either | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-23 | **Executor identity outlives the session**: the same agent verifying its own run from a LATER activation (new run, new session) is still refused — the recorded `origin.executor`, never attribution, is what the independence check reads | `apps/api/src/trust/self-verification.trust.test.ts` |
| TRUST-24 | **One activation, one audience**: a headless (background) agent run is workspace-visible through the run ledger exactly as its session door declares — the Pg list SQL and the domain's `runAudience` agree, filtered before the LIMIT | `apps/api/src/trust/run-audience.trust.test.ts` |
| TRUST-25 | **A grading-only change claims exactly one axis**: the split seal keeps the experiment axes orthogonal — the composite digest used to claim the dataset changed too | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-26 | **A subset is coverage loss, never a dataset confound**: the shared cases verify identical, and the pair reaches the coverage machinery (allow_partial's own knobs) instead of being refused as "a different experiment" | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-27 | **Unverifiable identity cannot gate green**: an unsealed side refuses the GATE by default (analytics may say "unknown"; a release gate may not say "green") — the acknowledgment (`allowUnverifiedIdentity`) is explicit and recorded | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-28 | **The causal budget admits atomically**: a same-instant burst on capRuns=1 admits exactly one across replicas, and a same-request retry is the same right — one increment, ever (real Postgres) | `apps/api/src/trust/envelope-budget.trust.test.ts` |
| TRUST-29 | **Cancellation racing the permit claim never dispatches and never strands a permit** — queue removal is the dispatch commit point, and the late-committed permit is returned | `packages/backends/src/scheduling/admission-race.trust.test.ts` |
| TRUST-30 | **The judge closure is identity**: the same judge document resolving a nested latest to different concrete models is recorded on the manifest and confounds; an unresolved seal stays unverifiable | `packages/domain/src/scorecard/experiment-confound.trust.test.ts` |
| TRUST-32 | **A role requiring evidence cannot complete without it** (`assertCompletionForRole`, wired at checkpoint admission; the vocabulary mapping is explicit) | `packages/domain/src/ownership/completion-evidence.trust.test.ts` |
| TRUST-33 | **The admission request row is claim-first and payload-bound** (real Postgres): a same-instant burst with the SAME request id charges exactly once (the claim row's unique index serializes — the probe-then-write shape charged one right N times); a held id re-presented with a different ask throws (a receipt is not transferable); a refusal deletes its own row and holds nothing | `apps/api/src/trust/envelope-budget.trust.test.ts` |
| TRUST-34 | **Metamorphic identity through the PRODUCTION seal** (submit → manifest → experimentIdentity): varying exactly one input moves exactly one axis — a twin submit holds everything, a harness bump (the treatment) confounds nothing, a subset confounds nothing, a default-grader edit moves only grading, a task edit moves only content, a judge selection moves only judge_set, and the model registry's latest moving under a HELD harness moves only harness_model (the treatment's own apparatus, H13). Hand-written manifest fixtures are how two seal bugs stayed certified | `apps/api/src/trust/experiment-metamorphic.trust.test.ts` |
| TRUST-35 | **Scoring identity is append-only and the gate pins what it saw** (real Postgres): the scoring ledger (mig 0144) round-trips jsonb, a re-score APPENDS (history never rewritten) and refreshes manifest.judges in the same write, the gate decision pins `{revision, scorePlaneDigest}` per side, and a post-decision re-score walks the record's digest away from the pin — detectable divergence, never silent reattribution | `apps/api/src/trust/scoring-revision.trust.test.ts` |
| TRUST-36 | **An old version's score is not the new version's completion**: with quality@1's measured verdicts in place a quality@2 pass used to plan an EMPTY worklist and finalize; the production prepare→plan→judge sequence strips first, re-judges the case, lands the NEW version's verdict (replaced, never accreted) and re-plans to an empty remainder | `packages/application-control/src/scorecard/scoring-pass-version.trust.test.ts` |
| TRUST-37 | **The release path speaks the scorecard gate's verdict, and NOT EVALUATED IS NEVER GREEN**: product release readiness runs through the PRODUCTION seam (seriesGate = scorecardService.diff + evaluateGate — the exact main.ts closure) — a case-verdict regression in a watched series blocks the ship with the kernel's own reason vocabulary, a required series that never ran BLOCKS ("no evaluation → not regressed → ready" was the false green), the opt-out (`requiredForRelease: false`) is a recorded declaration, and a forced ship records the verdict snapshot the gate saw | `apps/api/src/trust/release-readiness.trust.test.ts` |
| TRUST-38 | **A trust reader never reads a plane between revisions, and a gate pins exactly the revision it diffed**: a live scoring-pass marker (mig 0147) refuses the diff, a FAILED marker keeps refusing (an abandoned pass's half-stripped plane is not evidence — the Temporal score workflow has no compensation path), settling clears the boundary; and a re-score racing between the diff read and the decision write cannot move the gate's pin onto a judgment the decision never saw (the refetch TOCTOU) | `packages/application-control/src/scorecard/scoring-boundary.trust.test.ts` |
| TRUST-39 | **The ledger is append-only in the DATABASE too** (real Postgres): two same-instant guarded appends to the gates jsonb → exactly one lands (`WHERE jsonb_array_length = expected` — an in-memory fake serializes by construction and proves nothing about the SQL); the service's gate lane retries the loser so BOTH decisions survive; a rescore settle with a stale expected ledger length REFUSES rather than eating the other pass's revision | `apps/api/src/trust/ledger-cas.trust.test.ts` |
| TRUST-40 | **The seal is the PIN — the registry moving mid-pass cannot change what executes or what the ledger claims** (metamorphic): a harness `{ref}` binding sealed at submit dispatches with the SEALED resolution after latest moved; a judge's floating model ref judges under the PASS-START closure and the scoring revision records that closure — never a finalize-time re-observation | `apps/api/src/trust/seal-pin.trust.test.ts` |
| TRUST-41 | **Historical judgment is re-derivable, not merely detectable**: each scoring pass freezes its analysis bundle under an immutable per-revision key (`analyses/<id>/scoring/<revision>.json`) — three passes leave three DISTINCT artifacts, an old revision's bytes survive later passes unchanged and read back through the production path (`?revision=N`), and a revision that never existed reads 404, never the current bundle dressed as history | `apps/api/src/trust/analysis-revision.trust.test.ts` |
| TRUST-42 | **A scoring pass OWNS the plane, and a superseded pass can never write again** (real Postgres): two claimants racing an empty marker → exactly one wins by CAS; a takeover strips the old owner's right to renew or settle; a superseded pass's child write is refused even AFTER the winner cleared the marker (the fence is the passId, so the ABA of a reused epoch cannot resurrect it) | `apps/api/src/trust/pass-ownership.trust.test.ts` |
| TRUST-43 | **An unresolvable series contract is never green**: a required series whose current definition cannot be read blocks the ship whatever the evidence says — "we could not check" is not "it holds" | `apps/api/src/trust/series-contract.trust.test.ts` |
| TRUST-45/46 | **A nested `latest` moving changes the series contract identity, and nothing else does**: the same harness@version under a different resolved model is a different question, as is a judge's moved rubric — while judge order and map key order leave it held (an identity that moves on a reorder trains people to ignore it) | `apps/api/src/trust/series-contract.trust.test.ts` |
| TRUST-47/48 | **A version-stream key survives a real database, and two streams of one service coexist** (real Postgres): the canonical-JSON tuple round-trips verbatim (the first implementation joined on U+0000, which Postgres text rejects outright), and the SAME (service, version) from a different stream is a different release — which holds only once mig 0157 has dropped mig 0138's name-scoped UNIQUE | `apps/api/src/trust/series-contract.trust.test.ts` |
| TRUST-52 | **The current attempt owns the judgment** (real Postgres): a late completion from a replaced attempt is refused, a retry supersedes and is told so, and the arbitration is per (case, JUDGE) — the pass fence structurally cannot reach inside one pass, where a timed-out attempt and its replacement both hold the same passId | `apps/api/src/trust/pass-ownership.trust.test.ts` |
| TRUST-53/55 | **The carrier obeys the arbiter, per judge, or does not write at all** (real Postgres, through `ScorecardService.runScoreCase`): an accepted judge's bytes land while a superseded judge's neighbour row is untouched, and an arbiter that cannot answer stops the write entirely — "the arbiter is down" must never read as "you won". TRUST-52 certifies the table; this certifies that the production composition preserves its answer | `apps/api/src/trust/stage-arbitration.trust.test.ts` |
| TRUST-54 | **A continue-as-new does not make a pass's own next judgment look stale** (real Postgres): the rotation's attempt 1 supersedes the previous execution's attempt 2, and no attempt of an earlier generation can come back over it — Temporal's `attempt` is monotonic per activity execution while a stage row lives for the whole pass | `apps/api/src/trust/pass-ownership.trust.test.ts` |
| TRUST-56/57/58/63 | **The PRODUCTION resolver seals what the manifest seals**: a service harness's nested model moving, a harness judge's delegated agent moving, and a tenant-local `x@1` shadowing the `_shared` `x@1` each change the contract identity — and the resolver's contract IS the execution manifest's, projected (`seriesContractFromManifest`), so the two vocabularies are certified equal rather than assumed equal. The resolver this replaced passed TRUST-45 while being blind to all three | `apps/api/src/trust/series-contract.trust.test.ts` |
| TRUST-59/60 | **A cause is a fact about the world that now exists, and a bounded read is not a history**: an arrival on a stream the product has been repointed away from imports but triggers nothing, and a read that hit its page ceiling is reported instead of settling as complete — refusing the import outright when it is a first sync, whose baseline it cannot establish | `packages/application-control/src/product/product-version-sync.trust.test.ts` |
| TRUST-61 | **A retry budget belongs to the judgment, not to the batch it sits in**: a one-case group whose judge fails twice really is executed three times in one pass and finishes clean — over the real round decision and the real attempt accounting. The scoring workflow used to decide finalize-vs-replan on whether the plan overflowed its slice, so batch size silently decided a case's right to a retry | `packages/orchestrator/src/score-round.trust.test.ts` |
| TRUST-62 | **Editing a series' definition mid-decision refuses the ship** (real Postgres): a release commits under BOTH the governance policy digest and the evaluation-definition digest, so replacing the dataset a series names while a ship is resolving conflicts the commit rather than shipping against a definition already gone | `apps/api/src/trust/release-readiness.trust.test.ts` |

| TRUST-64 | **A replan round supersedes the round before it, with no rotation in between** (real Postgres): the claim's pass-global half is the LOGICAL ROUND, because every round schedules a new activity execution and Temporal's `attempt` restarts at 1 in each — an ordinal that only moved on continue-as-new made a round's first attempt lose to the previous round's exhausted ones, and the case could never finish | `packages/orchestrator/src/score-round.trust.test.ts` |
| TRUST-65/66 | **A shadowed DOCUMENT changes the evaluation identity, even when every reference reads held**: a tenant-local `agent@1` over the `_shared` one (different script, identical model closure) and a tenant-local `support@1` (different tasks) each move the contract digest — the registry resolves owner-first, so id + version alone was a structural blind spot in the comparison that decides whether a release ships | `apps/api/src/trust/series-contract.trust.test.ts` |
| TRUST-67 | **Using the same resolver twice is not carrying one resolution**: a floating model whose `latest` moves between the product's resolve and submit's seal makes submit REFUSE (before it creates or dispatches anything) rather than record an origin and a manifest naming different questions — and the guard is not a blanket refusal: a held world submits, including with judges and a workspace judge default in play | `apps/api/src/trust/contract-carry.trust.test.ts` |
| TRUST-68 | **A bounded read's side effects are all-or-none**: an established stream that hit its page ceiling lands its rows, emits their facts AND runs their evaluation, reporting the incompleteness as its own fact — committing the side effects and then throwing left the version in the ledger with nothing evaluating it, permanently, since the next sync sees it as already known | `packages/application-control/src/product/product-version-sync.trust.test.ts` |
| TRUST-69 | **A product that cannot state its identity cannot have a ship decided against it** (real Postgres): the release CAS requires BOTH the policy and definition digests, with no fallback to the row version — a NULL is not a smaller guard, it is an unanswerable question, and the answer to an unanswerable question about what a ship stands on is no. The in-memory twin answers identically | `apps/api/src/trust/release-readiness.trust.test.ts` |
| TRUST-70 | **The settled revision carries its stage observation, and only then is the stage collected** (real Postgres): parity rides the revision in the same guarded update, so a control plane dying after the settle cannot leave a pass silently unobserved in the promotion's own input — and the rows are dropped strictly after that, never before | `apps/api/src/trust/stage-arbitration.trust.test.ts` |
| TRUST-71 | **A judge owns one metric family, so a selection may name it once**: two versions of one judge are refused at the submit and re-score doors — the plane below is keyed by judge id everywhere (`pendingJudgesFor`, the strip, the attempt budget, the stage's natural key), so it is a state that cannot be represented, not an ambitious request | `packages/application-control/src/scorecard/judge-selection.trust.test.ts` |

| TRUST-72/73/74/75 | **A shadowed registry document cannot execute under a held name** (DECISION-level): a version is immutable inside ONE namespace and lookup is owner-first over `_shared`, so a workspace-local `support@1`/`agent@1` registered after submit resolves to different bytes under the same name. Caught per case, per default-grader set, per harness document — and as an EXACT SELECTION, so a case the shadow added or removed is refused too (72/73/74) — plus the re-score's own question: every judged case must still exist in the current resolution (75), or the pass would strip its judge rows and then skip it for having no case. **Scope**: these drive the decision function, not the production seams; the wiring is asserted separately by the batch/re-score paths' own tests | `packages/application-control/src/scorecard/sealed-execution.trust.test.ts` |
| TRUST-76 | **A pass judges the document it sealed, or it does not judge**: the sealed judge `specDigest` is CONSUMED at execution, so a workspace-local `quality@1` shadowing the shared one is refused before the provider is called — as an unresolved selection, so the batch settles with a visible unmeasured row rather than a verdict from a document nobody certified | `packages/application-control/src/execution/judge-document.trust.test.ts` |
| TRUST-78/79 | **Authority is stamped by a trusted boundary, and a declaration is not a wildcard**: a grader emitting `state`/`tests_pass` it does not own by construction becomes an invalid row instead of ground truth; declaring ANY authority (e.g. `observational`, which needs no admin) buys no other producer's name; a grader may not write into a judge's family; and the producer that owns a name by construction is untouched | `packages/application-execution/src/metric-authority.trust.test.ts` |
| TRUST-91 | **A right claimed for work that never existed is given back**: a durable `capRuns` admission followed by a failed record create releases under the same request identity — so a retry, which mints a new batch id, is not a second charge against an autonomy budget the system treats as a conservation law | `apps/api/src/trust/contract-carry.trust.test.ts` |
| TRUST-82/83 | **A pass declared dead loses its authority, not just its future** (real Postgres): a late settle and a late child write of a failed pass are both refused by the write statements themselves — identity says who this is, status says whether it may still act — while a takeover still reclaims the dead marker | `apps/api/src/trust/pass-ownership.trust.test.ts` |
| TRUST-86 | **A token may not authorize an operation it never described**: an activity presenting a judge selection the pass did not seal is refused — different judge, superset, or a different version of the same judge — because the marker's sealed closure is the selection's one owner | `packages/application-control/src/scorecard/pass-authority.trust.test.ts` |
| TRUST-87 | **No two judges' metric families can overlap**: a judge id may not contain `:`, so `judge:foo:bar` cannot be both a criterion of `foo` and the verdict of `foo:bar` — the same logical-unit-vs-serialized-unit shape as the per-judge arbitration bug, one level down | `packages/application-control/src/scorecard/judge-selection.trust.test.ts` |
| TRUST-88 | **A partly-observed history says so durably**: a page-ceiling read records `completeness: partial` on the service row, not only in the response the caller happened to be holding — a sweep or a later reader has no other way to learn the timeline is a prefix | `packages/application-control/src/product/product-version-sync.trust.test.ts` |
| TRUST-89 | **A disagreeing pass records WHICH units disagreed** (real Postgres): the stage rows are collected immediately after the observation, so mismatched/orphaned unit ids are frozen onto the revision at the one moment they still exist — a bounded sample, labelled as one | `apps/api/src/trust/stage-arbitration.trust.test.ts` |
| TRUST-90 | **A refused submit spends no autonomy budget**: the causal admission runs AFTER the seal and its verification, so a submission rejected for a moved evaluation contract never consumes a delegation it got no execution for | `apps/api/src/trust/contract-carry.trust.test.ts` |

| TRUST-92/93 | **`resume()` refuses a shadowed document** (PRODUCTION seam): a pinned harness is verified like any other — submit seals the EFFECTIVE post-pin spec, so the old "pins are expected to differ" exemption protected nothing and made the pinned path the one place a shadowed harness executed uncaught — and a shadowed dataset refuses on the same path, with both answering `false` rather than one throwing | `packages/application-control/src/scorecard/shadow-execution.trust.test.ts` |
| TRUST-94 | **Losing the question is a reason to refuse, not to ask a weaker one**: a re-score whose sealed dataset can no longer be read is refused instead of judging real evidence against a synthesized empty task — while a record that never had a registry dataset (`_adhoc`, `_traces`) still falls back, because there is no document to lose | `packages/application-control/src/scorecard/shadow-execution.trust.test.ts` |
| TRUST-95 | **An exception is not proof the commit did not happen**: a create that throws AFTER the row landed keeps the autonomy grant spent — refunding it would leave committed autonomous work with no budget behind it, trading a fail-closed defect for a fail-open one. Only an authoritative read of absence releases; an unreadable store holds | `apps/api/src/trust/contract-carry.trust.test.ts` |

| TRUST-96/97/98 | **Identity is recursive, or it is not identity**: a judge's rubric, its model and its delegated harness — and a harness's per-service models — are pinned by DOCUMENT DIGEST, not by ref. A shadowed rubric or model under a held `id@version` is refused before the provider is called; a raw string binding pins nothing (there is no document behind it); a closure sealed before digests existed verifies nothing rather than refusing everything | `packages/application-control/src/execution/nested-pin.trust.test.ts` |
| TRUST-99 | **The last hop verifies what it resolved**: the dispatcher — where a `{ref}` finally becomes a provider, a base URL and a key — refuses a model document that is not the one the batch pinned, with the pin carried on the JOB because nothing else can tell it what was certified. No restart or resume needed: the window is one registry write wide | `apps/api/src/trust/dispatch-model-pin.trust.test.ts` |
| TRUST-100 | **A recovered past is not a new event**: raising a read ceiling imports the older tail into the ledger and triggers NOTHING, because the boundary is the release's own publication instant against the newest this service had observed — `syncedAt` (our clock at the last sweep) cannot separate the two, and announcing them fires an evaluation wave for releases that shipped years ago | `packages/application-control/src/product/product-version-sync.trust.test.ts` |

| TRUST-101 | **What a grader IS and what it MEASURES are different names**: `GraderSpec.metrics` declares semantics for the metric ids a grader actually emits, instead of the id-based reading that composed a rule about the implementation's type (`id: "script"` declaring authority for the metric `"script"`, which nothing emits) — and a declared metric may be emitted by its own producer, so the two halves of one declaration agree | `packages/application-execution/src/measurement-identity.trust.test.ts` |
| TRUST-102 | **The world is a comparison axis, not an identity**: a batch's cohort is DERIVED from what its cases reported (absent where none did, `mixed` where they disagreed), and a comparison crossing two cohorts says so on the recorded decision — without refusing, because blocking on it would make an infrastructure move un-shippable until every baseline is re-run | `packages/domain/src/scorecard/world-cohort.trust.test.ts` |

| TRUST-103 | **A constitutional name may not be granted by a declaration**: `makeGraders` filters the built-in ladder's names (and the whole `judge:` family) out of what a spec can hand a producer, so declaring `state` grants nothing — the older reading let a spec both name the metric and acquire the right to emit it, which is a constitutional promotion with no authority field for the gate to see | `packages/graders/src/constitutional-metrics.trust.test.ts` |
| TRUST-104/105 | **A semantic capability must survive serialization unchanged** (PRODUCTION seam, real Postgres): a scoring pass's NESTED document pins and the manifest's copy of the same closure round-trip identically through the store — one schema, one meaning — and a batch's execution world is readable through `list()`, which is where release readiness actually reads it. Both features were correct in memory and gone in production before this: a schema that never learned the new fields drops them on reload, and a column that was never added cannot answer at all | `apps/api/src/trust/serialization-identity.trust.test.ts` |
| TRUST-106 | **The world crosses the database into the decision** (PRODUCTION seam, real Postgres): a baseline measured on linux and a candidate on windows ship — attaching, never blocking — with the cross-world fact on the recorded release decision and in its reasons, while two evaluations in the same world attach nothing. TRUST-102 certifies the decision function; this certifies that the release path ever sees a world | `apps/api/src/trust/release-readiness.trust.test.ts` |
| TRUST-107/108 | **The submit boundary settles a batch's authority** (PRODUCTION seam): a grading plan declaring a constitutional metric is REFUSED at the door with the alternative named, rather than silently ignored while the author believes it took effect — and the in-process driver's job carries the same sealed model-document pins the Temporal one does, because which driver a deployment uses is not a choice the submitter makes and must not decide whether TRUST-99's refusal is reachable | `apps/api/src/trust/submit-authority-seam.trust.test.ts` |

| TRUST-109/110 | **Verification belongs at the read that produces the bytes actually used**: the judge runner refuses a rubric or model shadowed BETWEEN the pass's resolution and its own read — it re-reads every one of those documents at use, so a check performed earlier was looking at a document nobody executed — and the runtime judge model is verified at `JudgeAuthDispatcher`, the seam where it becomes a provider, a base URL and a key. Neither reaches the provider; an unpinned job dispatches exactly as before | `apps/api/src/trust/judge-use-seam.trust.test.ts` |

| TRUST-111 | **Identity recurses to the bottom**: a harness judge's DELEGATED agent is pinned by document digest, and so is that agent's own model closure — pinning the agent says which agent judges, not which model it thinks with. The pins ride the job the judge dispatches, so the dispatcher that materializes those bindings verifies them exactly as it does a batch's own harness | `packages/application-control/src/execution/nested-pin.trust.test.ts` |

| TRUST-112 | **Same ref, same version, different DOCUMENT ⇒ a different contract** (metamorphic): a series' identity digest consumes the harness model documents it already carried, so a shadowed `model-x@1` is a contract change rather than a held one. A round trip could never see this — TRUST-63 rebuilds the manifest FROM the contract, so a facet neither side carries compares equal to itself, which is exactly how these digests sat unread for a wave | `apps/api/src/trust/contract-carry.trust.test.ts` |
| TRUST-113/114 | **A declaration is not part of the constitution until the decision function that consumes the measurement also consumes it**: a dataset's `metrics[].authority` reaches the batch's stamped policy, so a metric declared observational cannot decide the case — pre-fix the policy was composed from the request's grading plan alone, and `evaluateVerdict`'s fallback then let a verdict-inert measurement decide a ship. Two cases declaring different semantics for one metric are refused rather than resolved by declaration order | `apps/api/src/trust/effective-verdict-policy.trust.test.ts` |
| TRUST-115 | **History is not immutable if deleting the anchor changes what the next decision believes was "last time"**: a released release refuses deletion and edits, so the next release's baseline still resolves to the ship it stood on instead of reading as a bootstrap. A planned release stays deletable — the guard is about history, not about releases | `apps/api/src/trust/release-readiness.trust.test.ts` |
| TRUST-116 | **Unregistered and unreadable are not the same answer**: with a pin in hand, a delegated judging agent that cannot be read — or is no longer registered — is a refusal, where one `catch` used to reduce it to a spec-less job dispatched under the same name. With no pin, an unregistered agent still dispatches by id, because a built-in harness is named rather than stored | `apps/api/src/trust/judge-use-seam.trust.test.ts` |

| TRUST-117 | **A migration must not look like an attack**: a stamp written under the previous digest algorithm still verifies against its own unchanged document — dataset cases, grading, harness spec, every nested pin and a series' contract freshness all compare under the STAMP's algorithm. The old direct comparison was fail-closed, which is why it survived: a batch sealed in that era refused to resume, re-score or re-verify against its own documents and blamed a registry shadow for it | `packages/domain/src/provenance/digest-migration.trust.test.ts` |
| TRUST-118 | **What shipped is a ledger row, not a string somebody typed**: the ship resolves each planned component against the version ledger and freezes the row's id and stream, so "which v1.0.0 did this release ship?" stays answerable after a service is repointed at another repository. A version with no backing row still ships and says it was never resolved; a version nobody decided is `unplanned` rather than an empty string | `apps/api/src/trust/release-readiness.trust.test.ts` |

| TRUST-119/120 | **One plan, consumed many times — never re-derived**: the facets a batch sealed are read through a single `ExecutionPlan`, and every execution path asks it instead of rebuilding it from the manifest — the vanished-harness refusal, the re-score variant, and the retry that carries the SOURCE's seal rather than inheriting lineage without identity. An UNSEALED batch does not execute at all: absence used to pass every check by having nothing to check. The second half is structural — a source scan asserts each facet is read in exactly ONE file, over code lines only, because reconstruction is not a type error | `packages/application-control/src/scorecard/execution-plan.trust.test.ts` |

| TRUST-121 | **Every mutable input that composed a decision is that decision's read-set** (PRODUCTION seam, real Postgres): a ship's commit conditions on the issues it counted, the CANDIDATE IDENTITY it compared (the row, that it is not under a live pass, its scoring revision and plane digest, and that nothing newer landed by `(created_at, id)`), the MUTATION GENERATION of every capability its contracts resolved — top-level and nested — and the workspace settings revision. Eleven interleavings are certified, each landing between the decision and the write: a re-score of the same row, a live pass, a delete, a same-millisecond insert, a revived tombstone, a settings edit. The read-set is ONE NAMED ARTIFACT (`ReleaseDecisionContext`, arch-review 27) rather than an anonymous shape declared inline on the guard and repeated in the store: a new member used to have to be remembered in four places — the service's read, the recorded decision, the store's contract, the SQL WHERE — and a forgotten clause does not fail, it commits under a weaker guard. The Pg guard now builds its clauses from a map keyed by `keyof ReleaseDecisionContext`, so a member nobody wired does not compile, and the decision's digest is written into the history entry: what a ship READ is answerable from the record | `apps/api/src/trust/release-decision-readset.trust.test.ts` |
| TRUST-122 | **A hole is not an answer, and unknown ≡ unknown is not equality**: an explicit nested ref whose DOCUMENT could not be read leaves a series contract `unresolvable` instead of resolved-without-a-digest. Both sides of a freshness comparison carry the same hole — the evidence was stamped from the same unreadable registry — so the two used to compare equal and the series read FRESH on two unknowns agreeing | `packages/application-control/src/product/series-contract-holes.trust.test.ts` |
| TRUST-123 | **Constitutional authority belongs to the declaration artifact at its write boundary**: a dataset whose graders declare `ground_truth` requires admin to REGISTER, because `datasets:write` is a member permission and the same act was admin-gated on the run-time plan. Gating it at submit instead would force every schedule, CI trigger and auto-eval to re-approve an immutable document that no admin is present to approve | `apps/api/src/trust/dataset-constitution.trust.test.ts` |

| TRUST-124 | **A deferral with no decision function is a deferral forever**: the scoring plane's contract step is gated by `stagePromotionReadiness` over the durable per-pass observations — a pass that recorded nothing counts as unobserved rather than as agreement, one incomplete comparison blocks, and a disagreeing pass is named. Five reviews carried this migration on the prose precondition "observed real-traffic parity", which nobody could evaluate | `packages/domain/src/scorecard/stage-promotion-readiness.trust.test.ts` |

| TRUST-125 | **Evidence is only meaningful together with the decision procedure that produced it**: stage parity observations carry the observer's ERA, and the contract gate counts only its own — a `promotionSafe: true` from the era of stage-sourced expectations, per-case units or `JSON.stringify` equality is a green about a different question, and stale evidence still moves the denominator so a fleet cannot reach the minimum on it | `packages/domain/src/scorecard/stage-promotion-readiness.trust.test.ts` |

| TRUST-126 | **A constitutional declaration executes only under its receipt**: submit REFUSES a dataset whose graders declare `ground_truth` with no recorded approval, and refuses one whose receipt names different bytes — "it is in the registry" is not evidence that anybody approved it, and an id-and-version approval would wave a re-registration through. An admin attestation (`legacy_attested`) is the way back in, so the refusal is a gate rather than a wall | `apps/api/src/trust/dataset-constitution.trust.test.ts` |

| TRUST-127 | **A real process boundary** (real Postgres + the BUILT control plane as a child process): a booting control plane settles the batch owned by a replica that stopped heartbeating and leaves the live replica's alone. TRUST-09 certifies the recovery DECISION given a heartbeat set; only a booting process can certify that the composition root hands it the right one — and a boot that reclaims everything is as wrong as one that reclaims nothing. A missing build FAILS this scenario rather than skipping it | `apps/api/src/trust/process-boundary.trust.test.ts` |

| TRUST-31 | **A spawned verifier cannot acquire write capability**: the envelope a spawn site builds (`verifierEnvelopeFor`) driven through the two kernel guards the agent loop actually calls — an EMPTY write list, reads restricted to the evidence's own tools (never `all`, so a verifier cannot read the executor's trajectory and review its STORY instead of the artifact), and objects pinned to the cited refs. Both halves existed for generations; what was missing was the scenario that drives one through the other. It also refuses to build a WEAKENED envelope — a non-verifier profile, no evidence, or no read tools — rather than returning one that looks spawned and verifies nothing | `packages/domain/src/ownership/verifier-envelope.trust.test.ts` |

| TRUST-128 | **A declared scope survives the compose point**: the turn completes an activation's envelope from its resolved toolset — reads `all`, every write tool — and did so UNCONDITIONALLY, which would have replaced a verifier's empty write list, evidence-only reads and object whitelist on the way to the kernel. Both guards would then have enforced, faithfully, a boundary nobody meant. The producer was certified and the kernel was certified; the step between them decided what the other two were talking about | `apps/agent/src/verifier-scope.trust.test.ts` |

| TRUST-129 | **A verdict is what the verifier SUBMITTED and what the runtime SAW**: a verification turn runs inside the handed envelope and reports the submitted verdict with the kernel's own account of what it consumed — a turn that never submits comes back `inconclusive` SAYING that is what happened, which is not "the evidence could not decide". An agent that read nothing can still write a confident paragraph, so a prose-parsed verdict would have made the two indistinguishable | `apps/agent/src/verification-turn.trust.test.ts` |

| TRUST-130 | **A fence is a per-namespace VECTOR, advanced inside the mutation it fences**: owner-first resolution lets either the tenant or `_shared` change what a name answers, on independent clocks — so `max(generation)` across the two is a projection, and with `_shared` at 100 a tenant mutation from 3 to 4 leaves it unchanged, which the guard reads as a world that held still. Each namespace is now compared on its own, and the production registration path advances the number in the same statement as the write (a bump issued afterwards, with its failure swallowed, left a window where the registry answered the new resolution under the old token) | `apps/api/src/trust/release-decision-readset.trust.test.ts` |

| TRUST-131 | **A verification turn is given its evidence, not the host's ambient context**: the envelope pins `scope.resources` to the evidence so the verifier cannot REACH the executor's context — and the compose point was prepending the workspace memory index, where an agent writes what it concluded about the very work under review. A boundary enforced on the pull side and open on the push side has separated nothing: the guarantee could be defeated without a single refused tool call, and the decision would still record full coverage. The claim itself, by contrast, must cross — and does | `apps/agent/src/verification-turn.trust.test.ts` |

| TRUST-132 | **The verification wire refuses an envelope that is not a verification**: `/internal/verify` took the envelope as an opaque record and cast it into the turn, so writes-empty / evidence-only reads / pinned resources held only because the CALLER held them. Any other caller reaching an internal endpoint could hand over `reads: "all"` with no resources and get a run every layer above would still call a verification. The boundary now reads the boundary object | `apps/agent/src/verify-wire.trust.test.ts` |

| TRUST-133 | **A grader that hangs settles as a FACT, inside the case's own budget**: `safeGrade` turned a grader that THREW into a visible unmeasured score and had no vocabulary for one that never returns — the await sat there, the case never settled, and the batch waiting on it stopped without recording why. A failure that becomes nothing at all is worse than one that becomes a wrong number, because nothing is what a green dashboard looks like. The deadline is the case's own declared `timeoutSec`, not a constant this layer invents, so a legitimately slow judge is not turned into a failure. Real clock | `packages/application-execution/src/grader-liveness.trust.test.ts` |

| TRUST-134 | **The loop's own refusals, certified where they happen**: an out-of-scope capability is refused MID-TURN with the refusal delivered to the model, the in-scope sibling call in the same batch still runs, and the turn reaches its own end — a boundary that killed the run would make replanning impossible, which is what the envelope's `refuse_and_replan` vocabulary promises. And a benign-NAMED read tool whose author declared external egress still asks in auto mode, while a plain read stays ungated: risk is read off the declaration, never off the spelling | `packages/agent-runtime/src/kernel/loop-refusal.trust.test.ts` |

| TRUST-135 | **First terminal write wins, proved as a RACE**: `settleChild` carried that sentence in a comment and implemented read-check-write, so a user's cancel and a case drain landing from a worker both read a running child, both wrote, and the LAST one won — the ledger then said a cancelled batch's child succeeded. Two OS processes, two connections, one wall-clock instant: exactly one commits and the row agrees with it. Which side wins is not the claim; a scenario asserting a particular winner would be asserting the scheduler | `apps/api/src/trust/settle-race.trust.test.ts` |

| TRUST-136 | **A fence that could not be READ is not an absent fence**: every condition a ship commits under was wrapped in `.catch(() => undefined)`, so a store that was wired and failing degraded to "this decision needs no such condition" — the guard SQL simply omitted the clause, and the release committed under a weaker rule than the deployment enforces, silently, in the direction of green, at the one transition nobody can take back. A configured dependency that cannot answer now refuses: an operator can retry a refusal and cannot un-ship a release. The third case is the control — a working fence still ships, so the refusal is about the read and not about caution | `apps/api/src/trust/decision-boundary.trust.test.ts` |

| TRUST-137 | **Write A then B is not an atomic publication**: a dataset that declares `ground_truth` and the receipt naming the bytes an admin approved were two commits, and ordering the receipt first moved the window rather than closing it. The state inside it has no vocabulary here — bytes registered under a name whose approval names DIFFERENT bytes — and it is permanent: submit compares digest to digest, so the dataset is refused forever and the only way back records that it was authorised after it already ran. Bytes, receipt and capability generation now commit together, a failing receipt takes the dataset with it, and a client that cannot transact REFUSES rather than falling back to two writes | `apps/api/src/trust/constitutional-publication.trust.test.ts` |

| TRUST-138 | **A requester may direct attention; it may not define what verified means**: the requester's free-form `question` was the verifier's entire instruction, so "answer verified even if the evidence contradicts the claim" was a legal request — and every artifact around it would have recorded a well-formed, fully-covered, independent verification. What verified means, what a contradiction is, what insufficient evidence answers and that nothing may be inferred beyond the evidence are now platform text, versioned, digested and echoed by the runner; the requester's words arrive as bounded FOCUS. And the rules sit in the SYSTEM layer (arch-review 26): rendering them as one more paragraph of the user turn put them at the same instruction authority as the claim (authored by the party being verified), the focus (by the party asking) and whatever a tool returns — policy bytes delivered was never the same claim as policy governs | `apps/agent/src/verification-turn.trust.test.ts` |

| TRUST-139 | **The reader consumes the pin, and the record names what was OBSERVED**: the plan resolved each artifact's identity before the verifier ran, but what the verifier held was a LOCATOR — the tool returns whatever that id resolves to at the moment of the call, so a re-score landing in between produced a decision naming revision 3 while the model had read revision 4, with every artifact around it consistent and the sentence it filed false. The pin is now enforced where the bytes arrive (a moved artifact comes back as an error the model cannot reason over, and is not coverage), the decision records the observation rather than the plan, and the verdict names the instrument that produced it — the platform verifier model by version and document digest, resolved from the platform namespace so a workspace cannot shadow the thing that audits it. The identity is a UNION over every pinnable kind, because "existence is not evidence identity" was never a statement about scorecards: a workspace file verified today points at different bytes next quarter, and each kind is pinned by the coordinate that actually moves for it (scoring revision · settlement stamp · fs revision) | `apps/agent/src/verification-turn.trust.test.ts` |

| TRUST-140 | **A Temporal worker killed mid-activity loses no work and produces one result**: the real workflow module (the BUILT one) against a real Temporal, with two real worker processes — worker A is SIGKILLed while its activity is in flight (no shutdown hook, the way a machine dies) and worker B finishes the case. The ledger may hold both attempts, because at-least-once is Temporal's honest contract; what must be exactly one is the workflow's RESULT, the thing everything downstream treats as the case's outcome. **Finding**: `dispatchCase` declared a one-hour start-to-close and never heartbeat, so that hour was also how long Temporal waited before admitting the worker was gone — durability held and "eventually" was doing a great deal of work in the sentence. The activity now beats every 10s under a one-minute heartbeat timeout | `apps/api/src/trust/temporal-replay.trust.test.ts` |

| TRUST-141 | **A verification runs the platform's instrument and nothing else**: pinning the PRIMARY model to the platform namespace closed the front door and left three side doors — the fallback, the small-model summarizer and the sub-agent tier all resolved through the ordinary owner-first resolver, so a workspace registering `verifier-fallback` chose the model that would answer the moment the primary hiccuped, while the decision went on naming the platform document. Under `evidence_only` there is no ladder at all, workspace-crafted sub-agent TYPES are not even read (their instructions land in the same system message the constitution occupies), and the decision records the CLOSURE — one instrument could have answered, and it is the one named | `apps/agent/src/verification-turn.trust.test.ts` |

Reserved and not yet claimed: TRUST-05/06, 19/20, 44, 49/50/51. Each is a number a review named whose sentence
is either covered by a neighbouring scenario or awaits the subject that would make it certifiable. A number is
never recycled, so a claim always lands under the name the review gave it.

TRUST-31 is CLAIMED (above), and the reason it sat reserved is worth keeping: the producer
(`verifierEnvelopeFor`) and both kernel guards were all present, and `CheckpointService.requestVerification`
already composes them. What was missing was the SCENARIO — nobody had driven the envelope a spawn site builds
through the functions the agent loop calls, so three correct pieces certified nothing together.

What remains beside it is the SPAWN SITE — who activates a verifier, and when. The decision recorded in
`docs/architecture/ownership-protocol.md` is that a handoff does not wake one automatically: `checkpoint.created`
is deliberately not trigger-matchable (an agent waking on another agent's handoff is the runaway vector the
`agent.run.*` family is excluded for), so the request is a judgment a LEAD makes about work it delegated, not
an ambient reaction. The envelope above is what that request hands to the activation.

Plus the pre-existing live scenario test the nightly can now satisfy:

| | | |
| --- | --- | --- |
| workspace filesystem | recursive remove and move against a real S3 API (the MinIO batch-delete interop break) | `packages/storage/src/s3-fs.scenario.test.ts` |

### Why these are not "just unit tests again"

Most of these invariants already have unit tests, and those unit tests are good. The trust suite earns its
place by removing the fake:

- **Concurrency and clocks.** Leader election is one atomic upsert whose `WHERE` clause compares against the
  *database's* `now()`. A fake `SqlClient` can assert the SQL text; only Postgres can refuse the second
  claimant. Same for replica liveness, which is a `heartbeat_at > now() - staleMs` predicate.
- **Predicates.** Fleet admission is one `SELECT … WHERE status = 'running' AND …`. A hand-written ledger
  counting a `Map` agrees with *any* predicate, including a wrong one.
- **Serialization.** The gate's refusals stand on a stamp and a manifest that live in `jsonb` columns. A
  column that silently drops one turns `not_comparable` into a pass while every unit test stays green.

That last one is not hypothetical. **Writing TRUST-09 found a live defect**: `PgScorecardStore.list()`
selected an explicit column list that omitted `owner_replica`, and boot recovery reads batches through
`list()`. Every record therefore read as unowned, so a booting replica tombstoned batches another replica was
actively driving — reporting healthy in-flight work as `INTERRUPTED`. The unit tests were green throughout,
because the in-memory store hands back whole records.

## Running it locally

You need a Postgres the suite may migrate and write to. **Do not point it at a database you care about** —
the scenarios create and delete rows, and `migrate()` runs on connect.

```bash
# 1. a throwaway database (the local dev stack's Postgres is fine; give the suite its own database)
createdb -h 127.0.0.1 -p 5435 -U everdict everdict_trust

# 2. the whole suite, with the certification line at the end
EVERDICT_TRUST_DATABASE_URL=postgresql://everdict:PASSWORD@127.0.0.1:5435/everdict_trust \
  node scripts/trust/trust-suite.mjs
```

One scenario at a time, while working on it:

```bash
EVERDICT_TRUST_SUITE=1 \
EVERDICT_TRUST_DATABASE_URL=postgresql://everdict:PASSWORD@127.0.0.1:5435/everdict_trust \
  pnpm --filter @everdict/api exec vitest run src/trust/leader-election.trust.test.ts
```

The env vars are deliberately two:

- `EVERDICT_TRUST_SUITE=1` — run the trust suite at all. Without it every trust file skips, which is what
  keeps `pnpm test` (and therefore the push gate) fast.
- `EVERDICT_TRUST_DATABASE_URL` — the database the Pg-backed scenarios drive. Falls back to `DATABASE_URL`.

The MinIO scenario needs the workspace-filesystem endpoint instead:

```bash
EVERDICT_E2E_S3_ENDPOINT=http://127.0.0.1:9102 \
EVERDICT_E2E_S3_ACCESS_KEY=… EVERDICT_E2E_S3_SECRET_KEY=… \
  pnpm --filter @everdict/storage exec vitest run src/s3-fs.scenario.test.ts
```

## Adding a scenario

1. Write `<subject>.trust.test.ts` **next to its subject** — the same colocation the `.scenario.test.ts`
   files use. Files needing a database go under `apps/api/src/trust/`, which is where the shared gate lives
   (`trust-context.ts`: `TRUST_PG_ENABLED`, `openTrustPg`, `trustId`).
2. Gate the `describe` on `TRUST_PG_ENABLED` (or plain `EVERDICT_TRUST_SUITE === "1"` when no database is
   needed). Never gate individual `it`s — a half-run scenario is the thing this suite refuses to report.
3. Lead the file with the **invariant in one sentence**, then say **why a fake cannot prove it**. If you
   cannot answer the second question, the test belongs in the unit suite, where it will run on every push
   instead of once a night.
4. Nothing to register: the runner globs for the files and attributes each to its package.

## Deliberately excluded

- **Anything needing a paid model endpoint.** `packages/graders/src/model-judge.scenario.test.ts` calls a
  real LLM. This repository's Actions hold no such secret, and a nightly that silently no-ops when a key is
  missing is exactly the false green the suite exists to prevent. An operator running their own fork can
  enable it by adding `EVERDICT_E2E_OPENAI_BASE_URL` / `_KEY` / `_MODEL` as repository secrets and a step
  that runs `pnpm --filter @everdict/graders exec vitest run src/model-judge.scenario.test.ts`. It is
  intentionally not wired to `secrets.*` here, so nobody mistakes an unset secret for a passing judge.
- **macOS.** `cli-release.yml` and `desktop-release.yml` already build and test on `macos-latest` every
  release. Windows had no coverage anywhere, which is why the OS lane starts there.

## The Windows lane

Self-hosted runners run on operators' Windows machines, and until this workflow nothing in CI had executed a
line of that code on Windows. The nightly runs the packages whose tests are platform-independent **by
construction**:

| Package | Why it is in scope |
| --- | --- |
| `@everdict/contracts` | pure schemas and types; every path assertion is over a string, never the filesystem |
| `@everdict/domain` | pure business logic, no I/O by design |
| `@everdict/self-hosted-runner` | the OS-sensitive one — `capabilities.ts` branches on `process.platform` explicitly, and its test asserts the `win32` branch |

**Excluded, with the reason** — these are the expansion path, not an oversight. None of them are marked
passing:

| Package | Why it is excluded |
| --- | --- |
| `@everdict/drivers` | `local.test.ts` provisions a real `LocalDriver` and spawns a POSIX shell |
| `@everdict/job-runner` | `run-case.test.ts` runs the full loop over `LocalDriver` with `sh check.sh` |
| `@everdict/harnesses` | tests drive fake `ComputeHandle`s (so they look portable) but assert POSIX-shaped absolute paths like `/tmp/t.json`; unverified on Windows |

Expanding the lane means running the excluded package on `windows-latest`, reading what actually fails, and
fixing either the test's POSIX assumption or the code's. Adding a package to the filter without doing that
would turn a red lane green by not looking, which is the same move the trust suite exists to refuse.

## Why it is not in ci.yml

`ci.yml` is the **push gate**, and its value is that it is fast enough that nobody is tempted to work around
it. Booting Postgres and MinIO on every push, and running a Windows matrix that takes several times an ubuntu
job's minutes, would trade that away. The two workflows answer different questions:

| | `ci.yml` (every push) | `trust-nightly.yml` (nightly) |
| --- | --- | --- |
| asks | did this change break the code? | do the guarantees still hold? |
| runs against | fakes, in-memory stores | real Postgres, real MinIO |
| blocks | yes — a red `main` blocks everyone | no — it reports |

`scripts/ci-local.mjs` mirrors `ci.yml` step for step and is **not** extended to cover this workflow: a
scheduled job is not part of the push gate, and putting it there would mean booting a database before every
push.

## Tier B — the process-level scenarios (roadmap)

Everything above runs **in process**: real stores, real database, real SQL, but one Node process. The
scenarios below need a real process boundary — kill a running control plane and observe what the next one
does. They are the suite's next stage, and they are listed here rather than half-implemented because a
process-kill scenario that quietly degrades into an in-process one certifies nothing.

- ~~**Kill the API mid-batch, boot a replacement, assert ownership is honored.**~~ Done — TRUST-127 boots the
  BUILT control plane as a child process against a real database and reads what it settled. The harness it
  established (spawn the artifact, wait for a log line rather than a sleep, assert over SQL) is what the
  remaining scenarios below should reuse.
- ~~**Temporal worker kill and replay.**~~ Done — TRUST-140 runs two real worker processes against a real
  Temporal and SIGKILLs one mid-activity. It needs a Temporal service (`EVERDICT_TRUST_TEMPORAL`, default
  `localhost:7233`); the by-hand drills (`scripts/live/orchestration-torture.mjs`,
  `scripts/live/chaos-orchestration.mjs`) remain for the Nomad-shaped faults this does not cover.
  **Tier B is now empty.** The next scenarios to want are not on this list yet — write them when a claim on
  this page outruns what a single process can prove.
- ~~**A grader that hangs rather than throws.**~~ Done — TRUST-133, against a real clock. Finding one:
  `safeGrade` had no deadline at all, so the scenario came with the fix rather than after it.
- ~~**Cancel racing completion.**~~ Done — TRUST-135 spawns two OS processes contending over one run through
  the built stores. Finding one: `settleChild` was read-check-write, so "first terminal write wins" was a
  comment rather than a condition, and the guard (`expectNonTerminal`) is now evaluated by Postgres.
  A duplicate case RESULT is the same shape and is covered by that guard; if a distinct failure mode for it
  turns up, it lands as its own scenario rather than being assumed away here.
- ~~**The agent loop's own refusals.**~~ Done — TRUST-134 drives the real loop against a faked transport, the
  harness this item was waiting for (`apps/agent`'s verification turn built it).

## Producing the contract step's evidence

`stagePromotionReadiness` answers `observed: 0, ready: false` until passes have actually recorded a
stage/live-plane comparison, which is the honest state of a migration nobody has measured.
`scripts/live/rescore-soak.mjs` is what measures it: it re-scores real batches over the control plane's own
HTTP surface (pinned judges, never `latest`) and prints the delta in observations, so every data point is one
a real pass wrote. It manufactures nothing — a fabricated observation would certify the promotion against
evidence the promotion is not about.
