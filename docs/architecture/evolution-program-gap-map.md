---
kind: wiki
title: "Evolution program — the four pillars, what holds today, and the gap each spec closes"
status: current
updated: 2026-09-02
anchors: [packages/contracts/src/harness/harness-template.ts, packages/contracts/src/records/evolution-campaign.ts, packages/application-control/src/evolution/campaign-service.ts, packages/application-control/src/capability/first-party.ts, packages/contracts/src/records/tracker.ts]
---
# Evolution program — the four pillars, what holds today, and the gap each spec closes

> **Status:** a gap analysis, written 2026-09-02 against the tree as it stands, after the code-evolution loop
> (`docs/architecture/code-evolution-loop.md`) landed. Every "holds" claim below names the file that holds it;
> every gap names the spec that closes it. The specs are separate documents so each can land, be refused, or
> be reopened on its own evidence. This page is the index and the order.

## What Everdict is for, in four sentences

The maintainer stated the program as four pillars, and the tree should be read against them:

1. **Any harness can be defined.** A repository-based coding agent (Claude Code, Codex, Hermes), a
   multi-service deployed agent (a LangGraph topology), a client that acts on an environment directly, and
   the environment itself.
2. **A harness has one identity, immutable versions, and a lineage** — and the skill seeds and wiki seeds it
   ships with hang off the harness VERSION, not off the workspace.
3. **A harness is run against open and internal benchmarks honestly**, and the run yields exact evidence
   that is the ground for the next evolution step.
4. **Evolution may change anything about the harness, but it must know WHAT to change and WHO should change
   it** — which repository owns that part, which coding harness is built inside that repository — delegate
   to that specialist, verify the actual issue was resolved, and only then proceed.

The rest of this page is, per pillar: what holds (verified), what is missing (numbered), and where the spec
lives.

## Pillar 1 — any harness can be defined

**Holds.** Three harness kinds, a closed `discriminatedUnion` in `packages/contracts/src/harness/harness-spec.ts`:
`process` (an in-sandbox program), `service` (a topology, `docs/service-harness.md`), `command` (any CLI
agent from a declaration, `docs/command-harness.md`). Every harness is authored as Template + Instance
(`packages/contracts/src/harness/harness-template.ts`, `docs/architecture/harness-taxonomy.md`); a
`command` template that declares a `conversation` contract is conversational and can be a delegation
profile's agent — that carriage was broken until today and is fixed in the same batch as this page. The
environments a case can name are `repo | browser | prompt | os-use` (`packages/contracts/src/execution/eval-case.ts`),
placed on `linux | windows | macos`. Built-in adapters: `ClaudeCodeHarness`, `ScriptedHarness`,
`CommandHarness` (`packages/harnesses/src`); the job-runner selects the adapter by kind
(`packages/job-runner/src/registry.ts`).

**Gaps.**

| id | gap | closed by |
|---|---|---|
| G1.1 | A **client** harness — one that acts on an environment through its API, browser or OS with no code of its own in the sandbox — has no shape of its own. A topology's `target` is a `browser` literal; an API target and an OS target do not exist, so a client is emulated as a `command` whose CLI happens to be a client. | `harness-definability-spec.md` §1 — **landed 2026-09-02** (declaration + acquisition; api observation proxy open) |
| G1.2 | The **environment is not an entity**. A case embeds its environment; a topology embeds its target; a campaign's subject is `agent | harness`. An environment cannot be registered, versioned, diffed, or evolved. | `harness-definability-spec.md` §2 |
| G1.3 | **Codex, Hermes and claude-code-router have no first-party template.** Codex ships as a one-shot `command` recipe; the others do not ship. The contract they need (`conversation`) is reachable from a template as of today. | `harness-definability-spec.md` §3 — **landed 2026-09-02** for codex + claude-code-router; hermes open |
| G1.4 | A harness **cannot see the case** beyond `{{task}}` and its own params — no per-case hook carries the case's environment or metadata into the command — and a `process` harness declares no `resources`. | `harness-definability-spec.md` §4 — **landed 2026-09-02** |

## Pillar 2 — one identity, immutable versions, lineage; seeds hang off the version

**Holds.** Instance versions are immutable and resolve to a document whose digest (`specDigest`) a scorecard
manifest seals (`packages/contracts/src/records/scorecard.ts`). Every register carries a `CapabilityOrigin`
— the channel, the intent it was born from, a note — and the knowledge graph records `succeeds` (same id,
version to version) and `born_from` (version to issue/scorecard/run) edges
(`packages/contracts/src/knowledge/predicate.ts`, `docs/architecture/evolution-lineage.md` Track A).
`diff_harness_versions` says which slot moved between two versions; `repinHarnessImages` mints a version from
digest pins. Skills (`packages/contracts/src/records/skill.ts`) and knowledge entries
(`packages/contracts/src/records/knowledge-entry.ts`) are versioned records with `refs: KnowledgePin[]` —
claims ABOUT an entity version's validity interval (`packages/contracts/src/knowledge/knowledge-node.ts`).

**Gaps.**

| id | gap | closed by |
|---|---|---|
| G2.1 | **No fork, no family.** `succeeds` is same-id only. A harness derived from another id — a Codex variant of the Claude scaffold, a workspace copy of a `_shared` template — records nothing about where it came from. | `harness-identity-and-seeds-spec.md` §1 — **landed 2026-09-02** |
| G2.2 | **Seeds hang off nothing.** A `KnowledgePin` is a claim about a version; it is not a declaration that a harness version SHIPS with a skill or a wiki page. No field on the instance names its seeds, so they are outside `specDigest`, outside the manifest seal, and nothing materializes them into the sandbox. Two runs of "the same version" can run with different skills. | `harness-identity-and-seeds-spec.md` §2 — **landed 2026-09-02** |
| G2.3 | **Lineage is three reads.** Origins live on the registry record, the version diff is a separate read, the graph edges a third; nobody composes "where did this version come from, what changed, and what did it ship with". | `harness-identity-and-seeds-spec.md` §3 — **landed 2026-09-02** |
| G2.4 | **Seed leakage is a rule nobody enforces.** The evolve skill says the candidate never receives the findings; a knowledge seed born from THIS campaign's evidence is exactly that leak, and nothing refuses it. | `harness-identity-and-seeds-spec.md` §4 — **landed 2026-09-02** |

## Pillar 3 — honest benchmarks, exact evidence

**Holds — and this is the pillar the tree has invested in most.** Two on-ramps (`packages/datasets/src/mapping.ts`
row mapping; `packages/datasets/src/terminal-bench.ts` task directories) and a first-party catalog
(`packages/datasets/src/catalog.ts`, `packages/datasets/src/travel.ts`). Scoring semantics are DATA:
`official | proxy` with the official evaluator and licence named, absence read as unstated. Verifier-private
tests run in a different container from the agent (`packages/application-control/src/execution/verifier-pass.ts`).
The manifest seals dataset, per-case, grading, harness closure and judges; experiment identity answers
`held | confound | unverified` per axis; authority is stamped, never inferred from a metric name
(`sanitizeScore`); trials use an unbiased pass@k, Fisher below the z floor, Benjamini–Hochberg with
suppressed marks kept; observations are three-valued; re-scores are an append-only revision ledger; the
campaign verdict is derived, never accepted (`docs/scorecards.md`, `docs/architecture/evolution-lineage.md`).
Evidence out: `analysisBundle` per pass (`packages/application-control/src/scorecard/scorecard-observability.ts`),
`diff_scorecards` with comparability and `missing` never zero-filled, `gate_scorecards` fail-closed, paged
trace reads, per-call cost on the trace.

**Gaps.**

| id | gap | closed by |
|---|---|---|
| G3.1 | **On-ramps are incomplete.** Terminal-Bench slices 2–5 are unbuilt (`docs/architecture/standard-task-formats.md`); there is no adapter for WebArena, tau-bench, BrowseComp or SWE-bench beyond `swe-bench-lite`; first-party seeding of `_shared` was removed, so a fresh deployment starts with zero benchmarks. | `benchmark-evidence-spec.md` §1 |
| G3.2 | **No agent-behaviour diagnosis.** `classifyFailure` is `infra | config | harness | agent` at the platform's granularity; an agent FAIL carries no `failure` at all, so "why did it fail" is judge prose plus a trace. | `benchmark-evidence-spec.md` §2 — **landed 2026-09-02** (judge-family score details) |
| G3.3 | **No platform-derived evidence record for the next step.** A round carries a verdict (counts) and `learned` (the driver's prose, explicitly advice). Nothing platform-authored says which held-out cases failed on the candidate, with what diagnosis, pointing at which trace pages. The next round's brief is built by the driver from raw reads. | `benchmark-evidence-spec.md` §3 — **landed 2026-09-02** |
| G3.4 | **Comparability stops at the label.** `official | proxy` says whether a number is citable; nothing exports a run in the benchmark's own report format with the evaluator identity attached. | `benchmark-evidence-spec.md` §4 — **landed 2026-09-02** (generic citable report; leaderboard file formats open) |

## Pillar 4 — change anything, but know what and who; verify the issue was resolved

**Holds.** The loop exists end to end: a frozen frame with `oracleScope` and a `delegation` budget, a
delegated coding agent in a sandbox session, Everdict building the candidate into its own managed store and
minting the version, a derived round verdict, a gate, an adoption and a merge
(`docs/architecture/code-evolution-loop.md`, `packages/application-control/src/evolution/campaign-service.ts`,
`packages/application-control/src/evolution/campaign-build-service.ts`). The first-party driver is the
`code_evolve` skill (`packages/application-control/src/capability/first-party.ts`).

**Gaps.**

| id | gap | closed by |
|---|---|---|
| G4.1 | **WHO is a question, not a lookup.** A template slot names its `source {git, repo}` and its `build`; it does not name the coding harness built inside that repository. The skill's answer is "list the profiles and ASK the member". | `evolution-routing-spec.md` §1 — **landed 2026-09-02** |
| G4.2 | **WHAT is a prose ladder.** Nothing attributes a failing held-out case to a slot — the service whose spans carried the failure, the tool that was misused. The driver reads traces and guesses. | `evolution-routing-spec.md` §2 — **landed 2026-09-02** |
| G4.3 | **The issue and the cases are not bound.** `ISSUE_LINK_TYPES` (`packages/contracts/src/records/tracker.ts`) has no `case`; a frame cannot be derived from an issue; the gate reads aggregate held-out counts, so "the actual issue was resolved" — THESE cases now pass — is never verified. | `evolution-routing-spec.md` §3 — **landed 2026-09-02** |
| G4.4 | **One build is one slot.** A hypothesis that touches two services needs two builds and a hand-composed pin set; `pin_harness_images` accepts several pins, the build door accepts one slot. | `evolution-routing-spec.md` §4 — **landed 2026-09-02** (one pull request per set; claim-before-mint) |
| G4.5 | **No memory across campaigns.** Campaigns list per workspace; nothing reads "everything ever tried on this harness" — the rounds, what lost, what each taught. | `evolution-routing-spec.md` §5 — **landed 2026-09-02** |
| G4.6 | **The subject is an agent or a harness.** An environment cannot be evolved (G1.2). | `harness-definability-spec.md` §2 |

## The order

Not the priority of the pillars — the dependency between the specs.

1. **Routing §1 (the maintainer map)** first. It is a field on a template slot and a pure resolver; it
   removes the "ask the member" step with no other dependency, and every later rung of routing reads it.
2. **Evidence §2–§3 (diagnosis, the round evidence record)** next, because attribution (routing §2) and
   target verification (routing §3) both consume the record, and neither can be honest over prose.
3. **Identity §2 (seeds on the version)** with **identity §4 (the leakage refusal)** in the same change —
   a seed that is part of the digest is a seed the oracle rule can read.
4. **Definability §2 (the environment entity)** before routing §6 / G4.6, because a subject that is not an
   entity cannot be a campaign's subject.
5. Everything else lands on its own evidence: definability §1/§3/§4, identity §1/§3, evidence §1/§4,
   routing §4/§5.

## Where the program stands (2026-09-02, end of day)

Landed the same day this page was written, each as its own commit with a RED-first counterexample: routing §1
(the slot's maintainer), §3 (targets, the issue's `case` links, frames derived from the issue), §5 (memory as a
subject filter), §2 (attribution); evidence §3 (the sealed round-evidence record) and §2 (judge diagnoses on it);
identity §2 (seeds on the version, materialized or refused), §4 (the seed-leak refusal) and §1 (forks recorded and
verified); definability §4 (case tokens, the process box, one resources predicate) and §3 (codex and
claude-code-router recipes).

Open, in the order they should land: definability §2 (the environment
entity — the largest, and the one that unblocks an environment as a campaign subject); evidence §1 (the
benchmark on-ramps, each an evaluator to port honestly). A Hermes recipe waits on its CLI's resume form.

## What would reopen this page

- A pillar restated by the maintainer. The four sentences above are the program; a fifth, or a change to
  one, re-opens the map rather than a spec.
- A gap closed by a change that did not land its spec's counterexample. The specs each name a RED test;
  a gap marked closed with a green suite and no RED is a gap still open.
- A "holds" line whose file moved. `anchors:` above name the files whose change should force a re-read.
