---
kind: decision
title: "Evolution routing — WHO from the template, WHAT from the evidence, the issue binds the cases, the gate verifies the targets"
status: accepted
updated: 2026-09-02
anchors: [packages/contracts/src/harness/harness-template.ts, packages/contracts/src/records/tracker.ts, packages/contracts/src/records/evolution-campaign.ts, packages/domain/src/evolution/campaign-gate.ts, packages/application-control/src/evolution/campaign-build-service.ts, packages/application-control/src/capability/first-party.ts, apps/api/src/api/campaign/request/build-campaign.ts]
---
# Evolution routing — WHO from the template, WHAT from the evidence, the issue binds the cases, the gate verifies the targets

> **Status:** spec for Pillar 4 of `docs/architecture/evolution-program-gap-map.md` (gaps G4.1–G4.5). The
> loop it routes exists (`docs/architecture/code-evolution-loop.md`); what does not exist is the part the
> program states most sharply — evolution "must know exactly which parts to modify and WHO is best placed to
> modify them, delegate to that specialist, verify the actual issue was resolved". Today the driver answers
> WHAT from a prose ladder, WHO by asking a member, and "resolved" by an aggregate count.

## What holds, and what this spec must not restate

A frozen frame with `oracleScope` and a `delegation` budget; a sandbox session for the coding agent; Everdict
building the candidate from the template's `source` + `build` recipe into its own store and minting the
version (`packages/application-control/src/evolution/campaign-build-service.ts`, one slot per build —
`apps/api/src/api/campaign/request/build-campaign.ts`); a derived round verdict that reads the build account
before the scorecard origin; a gate over the held-out block (`packages/domain/src/evolution/campaign-gate.ts`);
an adoption, a merge, a chain. The driver is the `code_evolve` skill
(`packages/application-control/src/capability/first-party.ts`). The tracker links an issue to `harness |
dataset | judge | scorecard | run | view | issue | product | release` (`packages/contracts/src/records/tracker.ts`).

## §1 — WHO is a field on the slot, and a pure resolver (G4.1)

**The gap.** A template slot names WHERE its code lives (`source { git, repo }`) and HOW it builds (`build`).
It does not name the coding harness built inside that repository — the one whose instructions file, tool
conventions and model that repository was written for. The skill's answer is to list the delegation profiles
and ASK the member, once per round, for a fact that does not change between rounds.

**Decision.** `HarnessSourceSchema` gains `maintainer?: { profile: string, version?: string }` — the
delegation profile (`DelegationProfileSpecSchema`, `packages/contracts/src/records/capability.ts`) that
maintains this repository. It lives on the slot because the slot is the SSOT of "this code, built this way":
a service slot of a topology, or the single slot of a `command` template. A pure resolver in contracts,
`resolveDelegate(template, slot)`, answers `{ kind: "profile", profile, version? } | { kind: "unmapped",
slot }` — total, no I/O, consumed by the campaign build service and by the skill through MCP (the admission
test for a contracts kernel function). `code_evolve` reads it and asks nobody; an `unmapped` slot is a brief
that says "declare a maintainer on the template" rather than a question to a member.

**Rejected: a workspace-level repository → profile map.** It is a second owner of a fact the template already
half-owns (`source.repo`), and a side table drifts from the template the moment a slot's repository moves
(rule `protocol` L3 — one owner, exported, imported).

**Counterexample (RED first).** A template whose `web` slot declares `maintainer.profile = "codex-web"`
resolves to that profile; a slot without one resolves `unmapped`, and the skill's round brief names the slot
and the field. Today the field is unknown and the brief says to ask.

## §2 — WHAT is attributed from the evidence, and says when it cannot be (G4.2)

**The gap.** A failing held-out case is a case id and a trace. Which SLOT is responsible — the service whose
spans carried the failure, the tool that was misused — is a question the driver answers by reading and
guessing, and the guess is not recorded as a guess.

**Decision.** `attributeEvidence(evidence, template)` in `@everdict/domain`, pure, over the round's
evidence record (`docs/architecture/benchmark-evidence-spec.md` §3): for each failing held-out case, the slot
its diagnoses point at — a `locus.service` matched to a `TemplateService.name`; a `locus.tool` matched to a
slot that declares it owns that tool (a new optional `owns: { tools: [...] }` on the service slot); a
`command` template's single slot by construction — and, when nothing matches, `unattributed` with the reason.
The answer rides the evidence record as `attribution`, and the brief names the slot from it. A driver that
overrides an `unattributed` answer names the slot itself, and the round records `slotChosenBy: driver`, so a
later reader can tell a measured attribution from a chosen one.

**Rejected: attribution by the delegate.** The coding agent will happily say the fault is elsewhere. The
attribution is derived from what the platform watched, before any delegate is briefed.

**Counterexample (RED first).** An evidence record whose two failing cases carry `tool_misuse` diagnoses
with `locus.tool = "browse"` attributes to the slot that declares `owns.tools: ["browse"]`; a third failing
case with a diagnosis naming no locus reads `unattributed`, and the brief says so.

## §3 — The issue binds the cases, and the gate verifies THOSE cases flipped (G4.3)

**The gap.** `ISSUE_LINK_TYPES` has no `case`, so an issue cannot say which cases it is about; a frame
cannot be derived from an issue; and the gate reads `heldOut.improvements >= 1 && heldOut.regressions === 0`
— an aggregate. A campaign opened against "these five cases fail" can adopt a candidate that improved five
OTHER held-out cases while the five still fail. "The actual issue was resolved" is never verified.

**Decision.**
- `case` joins `ISSUE_LINK_TYPES`, shaped `{ type: "case", datasetId, version, caseId }` — the issue names
  the cases that prove it, the way it already names the scorecard that proved it.
- The frame gains `targets?: string[]` — scenario ids the campaign exists to flip. Targets must be in
  `scenarios`, and are NOT held-out: the loop will optimize against them, so they cannot also be the
  population the gate reads for generalization. `POST /campaigns` accepts `frame: { fromIssue: true, … }`
  and derives `targets` from the issue's `case` links, `scenarios` from the linked dataset version, and
  `heldOut` as every non-target scenario.
- The gate, when `targets` is declared: adopt requires EVERY target to be a significant improvement AND
  `heldOut.regressions === 0`. The `heldOut.improvements >= 1` requirement is replaced by the targets — a
  narrow, correct fix improves what it was asked to and regresses nothing, and that is the adoption the
  program describes. Without `targets`, the gate is unchanged.

**Rejected: targets as held-out.** A case the loop is shown, briefed on, and optimizing against is not
held-out by any meaning of the word; counting it in the generalization block is the leak the held-out split
exists to prevent.

**Counterexample (RED first).** A frame with `targets: ["c3", "c4"]`; a round where `c1`, `c2` (held-out)
improve significantly, `c3` and `c4` do not move. Today the gate answers `adopt`. After the change it
answers `continue`, and the verdict names the targets that did not flip.

## §4 — A hypothesis that touches two slots is one build set and one version (G4.4)

**The gap.** One build is one slot. A hypothesis across two services needs two builds and a hand-composed
pin set through `pin_harness_images`; the two intermediate versions each build minted were never run, and
the round's `candidateSource` names one build.

**Decision.** `POST /campaigns/:id/builds` accepts `builds: [{ slot, ref, repo?, prNumber? }]` (the single
form stays as the one-element case). Each slot gets its own `CampaignBuildRecord` sharing a `setId`; the
version is minted ONCE, by whichever build completes last, in a conditional write that asserts every record
in the set is `built` (rule `protocol` L1 — the mint is the effect, the set's completeness is its proof).
`candidateSource` becomes plural on the verdict (`builds: [...]`), and the merge door pays one debt per pull
request.

**Rejected: mint per slot, then compose.** N−1 versions nobody ran, each a label a later reader cannot tell
from an evaluated candidate.

**Counterexample (RED first).** Two builds in one set; the first completes and NO version exists; the second
completes and exactly one version exists with both pins. A set whose second build fails leaves no version
and both records readable.

## §5 — Memory across campaigns is a read over the subject (G4.5)

**The gap.** Campaigns list per workspace. "Everything ever tried on this harness — the rounds, what lost,
what each taught" has no read, so a new campaign's first brief starts from nothing, and the same dead
hypothesis is spent twice.

**Decision.** `GET /harnesses/:id/evolution` and its MCP twin: every campaign whose subject is this harness
(any version), each with its rounds — verdict, `candidateSource`, the evidence reference (§3 of the evidence
spec), `learned` — and its close. `EvolutionCampaignStore.list` gains a subject filter applied in the query,
not after it. The `code_evolve` brief reads it before proposing.

**Rejected: promoting `learned` into knowledge entries automatically.** A finding is advice; a knowledge
entry is a claim, and a claim about the exam seeded into the next candidate is the leak
(`docs/architecture/harness-identity-and-seeds-spec.md` §4). Memory is read by the PROPOSER through this
read; it is not mounted into the candidate.

**Counterexample.** Two campaigns on one harness, the first halted `no_improvement` with three rounds;
the read returns both, the halted one's three `learned` entries included, and a campaign on a different
harness is absent.

## §6 — The subject

An environment as a campaign subject is `docs/architecture/harness-definability-spec.md` §2; a fix that
spans a harness AND its environment is two campaigns until then, and this spec does not pretend otherwise.

## What would reopen this

- A repository maintained by TWO coding harnesses (Codex for the frontend directory, Claude for the rest).
  §1 keys the maintainer on the slot; a slot whose repository is split needs the maintainer keyed on a path
  prefix, which is a frame's `oracleScope` grammar (`pathMatchesPattern`) pointed at ownership.
- Attribution that is right less often than the driver's guess. §2 records `slotChosenBy`, so the
  comparison can be made; if the measured answer loses, the `owns` declaration is the thing to fix, not the
  function.
- An issue whose cases live in two datasets. §3 derives one frame from one dataset version; two datasets
  are two frames, or one dataset that composes them, and the tracker should say which.
