---
kind: decision
title: "Benchmarks and evidence — finish the on-ramps, diagnose the agent, derive the round's evidence, export what is citable"
status: accepted
updated: 2026-09-02
anchors: [packages/datasets/src/catalog.ts, packages/datasets/src/terminal-bench.ts, packages/contracts/src/execution/case-failure.ts, packages/contracts/src/records/evolution-campaign.ts, packages/application-control/src/evolution/campaign-service.ts, packages/application-control/src/scorecard/scorecard-observability.ts]
---
# Benchmarks and evidence — finish the on-ramps, diagnose the agent, derive the round's evidence, export what is citable

> **Status:** spec for Pillar 3 of `docs/architecture/evolution-program-gap-map.md` (gaps G3.1–G3.4). This is
> the pillar the tree has invested in most; the sections below are additions, not repairs, and §2–§3 are the
> two the routing spec (`docs/architecture/evolution-routing-spec.md`) consumes.

## What holds, and what this spec must not restate

Two on-ramps — row mapping (`packages/datasets/src/mapping.ts`) and Terminal-Bench task directories
(`packages/datasets/src/terminal-bench.ts`) — and a first-party catalog (`packages/datasets/src/catalog.ts`,
`packages/datasets/src/travel.ts`) whose scoring semantics are data: `official | proxy`, with the official
evaluator and licence named and absence read as UNSTATED. Ported official scorers ship as judges
(`packages/datasets/src/judges.ts`). Verifier-private material never enters the agent's container
(`packages/application-control/src/execution/verifier-pass.ts`). The manifest seals dataset, per-case
documents, grading, the harness closure and the judges; experiment identity answers
`held | confound | unverified` per axis; authority is stamped at the producer boundary (`sanitizeScore`);
trials use an unbiased pass@k, Fisher's exact test below the z floor, Benjamini–Hochberg with suppressed
tests MARKED rather than dropped; observations are three-valued; re-scores are an append-only revision ledger;
a campaign's verdict is derived, never accepted (`docs/scorecards.md`; `docs/architecture/evolution-lineage.md`).
What a run yields: `analysisBundle` per scoring pass (`packages/application-control/src/scorecard/scorecard-observability.ts`),
`diff_scorecards` with comparability and `missing` never zero-filled, `gate_scorecards` fail-closed, paged
trace reads (`docs/architecture/long-horizon-trace-reads.md`), per-call cost on the trace
(`packages/contracts/src/execution/trace.ts`), and the platform-side failure taxonomy `classifyFailure`
(`packages/domain/src/failure/case-failure.ts`; `infra | config | harness | agent`).

## §1 — Finish the on-ramps, and say what a fresh deployment has (G3.1)

**The gap.** Terminal-Bench slices 2–5 are unbuilt — the ingestion edge, the benchmark-source kind for
`POST /datasets`, the image-provenance helper, the web wizard (`docs/architecture/standard-task-formats.md`).
There is no adapter for WebArena, tau-bench or BrowseComp, and SWE-bench exists only as `swe-bench-lite`.
First-party seeding of `_shared` was removed, so a fresh deployment holds zero benchmarks until an operator
runs `loadDatasetDir` (`docs/datasets.md`) — and nothing at boot says so.

**Decision.**
- Terminal-Bench slices 2–3 (ingestion edge + source kind on both doors) before 4–5; the source kind is the
  one that makes "open benchmark in" a declaration rather than a script.
- Adapters, in this order and each carrying its honest `scoring`: SWE-bench Verified (extend the
  `swe-bench-lite` builder; `official`, the harness's own evaluator image), BrowseComp (`prompt` env, the
  official exact-match scorer ported as a judge; `official`), WebArena (`browser` env; the evaluator's
  functional checks ported; `official` only where the port is exact, else `proxy` with `approximates`
  stated), tau-bench LAST — it needs a simulated user, which is a judge-side conversational agent, and so
  depends on the `conversation` contract (`docs/command-harness.md`) being reachable from a judge spec.
- Boot readiness reports the `_shared` dataset count, and the operator recipe for seeding is one documented
  command. Auto-seeding stays off: boot seeding is not workspace news (rule `events`) and a deployment
  that never asked for eleven benchmarks should not carry them.

**Rejected: a generic "any HuggingFace dataset is a benchmark" claim.** Row mapping already does that; what
makes a benchmark a benchmark is its evaluator, and an evaluator is either ported exactly (`official`) or
approximated (`proxy`). The adapter list above is a list of evaluators, not of datasets.

**Counterexample.** Importing a Terminal-Bench task set through `POST /datasets` with the new source kind
yields cases whose `tests/` bytes are verifier-private (`verifierPlanOf` extracts them; the agent container
never receives them) — the same assertion the mapper's tests already make, now through the door.

## §2 — Diagnose the agent, not only the platform (G3.2)

> **Landed 2026-09-02, riding the judge family rather than a new sealed document:** `CaseDiagnosisSchema` with
> the closed `DIAGNOSIS_KINDS` (`packages/contracts/src/records/evolution-campaign.ts`); a judge whose rubric asks
> for one writes it as its score `detail` (or under a `diagnosis` key beside its rationale), and `diagnosesOf`
> (`packages/domain/src/evolution/diagnosis.ts`) reads it off judge-family scores only — the family is the
> authority, and `sanitizeScore` already refuses a producer that names a judge metric it does not own, so
> "authored by a judge" is a fact rather than a label. Anything that does not parse is ignored: a rationale
> sentence is not a diagnosis. The diagnoses ride the round's evidence record per case (§3), sealed with it.
> Not landed: a separate diagnosis receipt (the judge's score already seals under its pass) and a first-party
> diagnosis rubric.

**The gap.** `classifyFailure` says what broke on the PLATFORM's side: a provision failure, a config error,
a harness crash, an agent that did not finish. An agent that finished and was WRONG carries no `failure` at
all, by design; "why" is the judges' prose plus a trace. That is the right split for a verdict and the wrong
input for a next step — nothing structured says "it looped on the same tool", "it answered the wrong
question", "it never opened the file the task named".

**Decision.** A `CaseDiagnosis` document, authored by a JUDGE and by nothing else:
`{ kind, locus?: { service?, tool?, phase? }, evidence: [event references], confidence }`, with `kind` a
closed vocabulary — `wrong_answer | incomplete | tool_misuse | loop | timeout | refused | environment_broken |
spec_misread` — extended only with a live producer. It is produced by a diagnosis judge (a `JudgeSpec` whose
rubric is the vocabulary; `docs/judges.md`), sealed beside the judgments with the same receipt discipline
(`packages/contracts/src/records/scorecard.ts`), and carries OBSERVATIONAL authority: it decides nothing,
it explains. `evidence` names trace events by their page coordinates so a reader lands on the event, not on
the run.

**Rejected (a): extending `classifyFailure`.** It classifies ERRORS the platform saw; it cannot see behaviour,
and making it guess from a trace would put a judgment inside a function whose whole value is that it does not
judge.

**Rejected (b): a producer-authored diagnosis on `CaseResult`.** A harness explaining its own failure is
the untrusted-ingress shape (rule `protocol`, the authorship law) — it is stripped at the door like every
other platform-authored field a producer sends.

**Counterexample (RED first).** A `CaseResult` submitted with a `diagnosis` field is stored without it
(the strip). A diagnosis judge's output over a run is sealed under the judge's identity and read back from
the scoring pass; a diagnosis whose `kind` is outside the vocabulary is refused at the seal.

## §3 — The round's evidence is platform-derived, immutable, and the input to the next step (G3.3)

> **Landed 2026-09-02 (without diagnoses, which are §2):** `RoundEvidenceSchema`
> (`packages/contracts/src/records/evolution-campaign.ts`), the pure builder `roundEvidenceOf` + the
> content-addressed `roundEvidenceKey` (`packages/domain/src/evolution/round-evidence.ts`), an insert-once
> `CampaignEvidenceStore` (`packages/db/src/evolution/campaign-evidence-store.ts`, migration 0205 — a Postgres
> table rather than the object store, because the object store is optional per deployment and the evidence
> may not be), `CampaignService.logRound` staging the object BEFORE the round is appended and naming it as
> `verdict.evidence { key, digest }`, and the read on both transports — `GET /campaigns/:id/rounds/:seq/evidence`
> and `get_campaign_round_evidence` — which refuses bytes that no longer digest to the seal. `diagnoses` joins the
> record when §2 lands; a field with no producer is a plan.

**The gap.** A round carries a verdict — counts, axes, `candidateSource` — and `learned`, the driver's prose,
which the design correctly calls advice (`packages/contracts/src/records/evolution-campaign.ts`). Nothing
PLATFORM-authored says: on this round, these held-out cases failed on the candidate, each with this
diagnosis, pointing at these trace pages, on this trial. The driver rebuilds that from raw reads every round,
and the brief for the next delegation is whatever the driver chose to write down.

**Decision.** `CampaignService.logRound` derives a `RoundEvidence` document from what it already reads —
the diff snapshot, the per-case trial results, the diagnoses (§2) — one entry per frame scenario:
`{ caseId, heldOut, baseline: { rate, trials }, candidate: { rate, trials }, verdict: improved | regressed |
unchanged | unclear, diagnoses: [...], traces: [{ runId, side, trial }] }`, plus the round's aggregate. It is
staged as an immutable object (key + digest, through the `ArtifactStore` port) BEFORE the round is appended,
and the round references it as `verdict.evidence: { key, digest }` — rule `protocol` L4: a decision
references frozen bytes by key and digest, never "the record's current results". Read through
`GET /campaigns/:id/rounds/:seq/evidence` and its MCP twin. The `code_evolve` round brief is rendered FROM
it — with one deliberate hole: the DELEGATE receives the failing case ids, the attributed slot
(`docs/architecture/evolution-routing-spec.md` §2) and the diagnosis KIND; it never receives judge rationale
or the diagnoses' evidence excerpts. That is the leak rule (`docs/architecture/harness-identity-and-seeds-spec.md`
§4) applied to the brief.

**Rejected: `learned` becoming structured.** `learned` is the one value the LOOP authors about its own walk,
and its whole value is that the gate does not read it. Making it structured would invite the gate to. The
evidence record is the platform's half; `learned` stays the driver's.

**Counterexample (RED first).** A round logged over a diff with two held-out failures has an evidence object
whose digest the round carries and whose bytes re-digest to it; a re-score of the candidate scorecard after
the round does NOT change what the round's evidence reads. Today a round references no evidence object at all — the analysis bundle is
per-pass and durable, but nothing on the round names a pass, so a reader re-deriving "what this round saw"
picks whichever pass is current (the L4 shape this section exists to avoid).

## §4 — Export what is citable, refuse to export what is not (G3.4)

**The gap.** `official | proxy` says whether a number may be compared with the paper's; nothing produces the
comparison. A tenant that wants to submit to a leaderboard, or quote a number in a report, transcribes by hand.

**Decision.** `GET /scorecards/:id/report?format=<benchmark>` rendering the scorecard in the benchmark's own
submission shape, with the evaluator identity and Everdict's sealed manifest digest attached. An adapter that
wants this declares a `reportFormat` renderer in `packages/datasets/src/catalog.ts`. A scorecard whose
scoring is `proxy` is REFUSED unless the caller passes `allowProxy`, and the export then carries `proxy` and
`approximates` in its header — a number that is not the benchmark's number is exported saying so or not at
all.

**Counterexample.** Exporting a travel-family scorecard (all `proxy`) without `allowProxy` is refused with
the `approximates` sentence; with it, the export's header says `proxy`.

## What would reopen this

- A benchmark whose official evaluator cannot run inside Everdict (a hosted grader with no API). §1 then
  ships it as `proxy` with `approximates` naming the hosted step, and §4 refuses to export it as official.
- A diagnosis vocabulary the judges cannot fill reliably. §2's `confidence` exists for that; a kind whose
  confidence is uniformly low is a kind to remove, not a judge to prompt harder.
- A round whose evidence is too large to stage (thousands of held-out cases). §3 stages per-case entries;
  the fix is paging the read, never truncating the object — a truncated evidence record is `missing` wearing
  a digest.
