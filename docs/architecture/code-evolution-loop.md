---
kind: wiki
title: "Code evolution loop — a delegated coding agent mutates the harness repo, CI builds the image, the campaign decides"
status: current
updated: 2026-09-02
anchors: [packages/application-control/src/capability/first-party.ts, packages/application-control/src/evolution/campaign-service.ts, packages/contracts/src/records/evolution-campaign.ts, packages/application-control/src/session/sandbox-session-service.ts, packages/contracts/src/records/capability.ts]
---
# Code evolution loop — a delegated coding agent mutates the harness repo, CI builds the image, the campaign decides

> **Status:** the DRIVER half landed 2026-09-02 as the first-party skill `code_evolve`
> (`packages/application-control/src/capability/first-party.ts`), composed from `delegate_work` and
> `harness_evolve`; and the RECORD half's first rung landed with it: a round now carries where its candidate
> came from (`verdict.candidateSource` — the candidate scorecard's origin coordinates, platform-derived). The
> remaining rungs are listed under "What is open", each with the seam it closes.

## The goal, as stated

A harness — a service topology or a single scaffold, living in whatever repository — is evolved by
**changing its code**, not only its pins. The change is made by a **coding agent** (Claude Code, Codex,
claude-code-router, …) working **in an isolated sandbox with the harness repository checked out**, the
result is **built into a Docker image**, and that image is what the **next round evaluates** and what an
adoption carries into the **next campaign's baseline**.

## Current state — verified

Almost every part exists. What does not exist is the seam between them.

- **A delegation profile is a coding agent in a box.** `DelegationProfileSpecSchema`
  (`packages/contracts/src/records/capability.ts`) pins `harness` (a built-in such as `claude-code`, or a
  registered one), `image`, a `model` binding whose key is injected as env, `env` with `{secretRef, scope}`
  values resolved at boot and never stored, a stable `workDir`, and standing `instructions` written to the
  file the CLI reads by convention (`instructionsFile`, default `CLAUDE.md`). The profile's own comment
  states the stance: the delegate is EMPLOYED, not under test.
- **A session is an isolated container with the repo cloned in.** `create_sandbox { profile, brief,
  repo:{git, ref}, runtime? }` boots the profile's image, clones the repository (a private one through the
  workspace GitHub App), and seeds the brief as `BRIEF.md`. `submit_sandbox_task` sends one turn at a time,
  `read_sandbox_task_trace` shows what the delegate actually did, `sandbox_exec` runs the driver's own
  checks, and `sandbox_git_push` publishes the branch with a token minted for that one call and never
  stored. The push is a guarded action (`apps/agent/src/action-policy.ts`): it pauses for a member.
- **Building happens in CI, and Everdict already consumes the result.** `docs/architecture/github-actions-trigger.md`:
  a PR fires an evaluation with the PR's image swapped into one slot as an ephemeral pin override, recorded on
  the scorecard as `origin.pinOverrides` beside `origin.repo` / `origin.sha` / `origin.prNumber`; a merge
  fires a durable re-pin that registers a new harness-instance version. `origin.source` is decided server-side
  from the caller's credential, so a `github-actions` origin is one the CI runner authored under OIDC.
- **The campaign is the settlement.** `docs/architecture/evolution-lineage.md` Track D: frozen frame,
  derived verdicts, held-out adoption gate, endings enforced at the write, an adoption spent by a registry
  effect that proves the digest before it writes.

## What was missing — and what this loop does about it

### D1 — the mutation step is a delegation, and the delegate is not the candidate

The `harness_evolve` skill's step 2 said "move one lever" and left the author of that lever to the driver. The
code loop makes the author explicit: the driver **delegates** the change to a coding agent through a
delegation profile, in a sandbox with the harness repository cloned, briefed with the campaign's findings.

This does not violate the oracle rule. The rule says the thing being MEASURED may not read the measurement's
notes; the delegate is the proposer, and the thing measured is the harness code it produces. What the rule
does forbid is the delegate writing those notes INTO the harness — its prompts, its config — or into the
oracle itself. That is D3.

**Rejected: making the coding agent the candidate.** One could register the coding agent as the harness
under test and evolve its configuration; that is `agent_evolve`, and it answers a different question. Here
the harness is a repository and the coding agent is a tool.

### D2 — Everdict does not build the image; CI does, and the campaign waits for it

**Rejected: a build step inside Everdict.** The platform's stated contract is that it REFERENCES images and
never builds them (`packages/datasets/src/terminal-bench.ts`, `resolveImage`). No sandbox lane carries
docker or buildkit, and adding one would make the control plane a build farm with a registry credential.

**Rejected: `snapshot_sandbox` as the candidate image.** A world snapshot commits a live container's
filesystem and registers it as an environment capability version. It is not a Dockerfile build of a commit:
it has no source coordinate, cannot be reproduced from a sha, and lands as a world, not a harness pin.

So the loop is: delegate → PR → the repository's own CI builds and pushes the image (the RepoLink's workflow
already does this for `pull_request`) → the CI-fired evaluation lands as a scorecard whose `origin` names the
PR, the sha and the pin override → the driver logs the round against it. The build is owned by the repository
that owns the code, which is where a build belongs.

**Landed:** `origin.campaignId` — a submitter (the CI workflow the driver set up, or the driver itself) may
name the campaign a batch is a round of; it rides the `scorecard.submitted` and `scorecard.completed` facts,
so a subscription filtered on it wakes the driver on exactly its batch. It is a finding key, never authority:
the round still verifies the batch's identity against the frame when it is logged.

**Still open — the PR-mode scorecard as the round's candidate.** The CI-fired evaluation runs the BASE
version with an ephemeral pin override, so its record names the base version and the round's identity check
(candidate version) and the adoption's spec comparison (the version the proof authorizes) both key on a label
the candidate does not have. Today the driver pins the CI-built digest into a REAL instance version
(`pin_harness_images`) and runs the round's batch on that, which is also what keeps the adoption's identity
exact. Admitting the PR-mode scorecard directly needs the round and the proof to key the candidate on its
resolved digest rather than its version label, and the adopt effect to mint the version — a change to the
adoption identity protocol that this record defers rather than half-lands.

### D3 — the oracle is a set of paths, and the candidate may not touch them

A coding agent with a repository checkout can edit the dataset, the judge rubric or the tests as easily as the
scaffold. Any of those is the candidate rewriting its own exam.

The frame is the place to freeze that boundary: an `oracleScope` of repository path patterns, declared at
open. A round whose candidate PR touches a path in scope is recorded `comparable: false` with the reason
`oracle touched` — the same treatment as a drifted scenario set, because it is the same defect: the exam
moved. **Landed:** `CampaignService.logRound` reads the pull request the candidate scorecard's origin names
(the workspace GitHub App's changed-files listing, a REQUIRED dependency that answers `unknown` where no App
is configured), matches it with `oracleTouched` (`@everdict/domain`), and records the offending paths on the
verdict as `oracleTouched`. Three answers, never two: clean, touched, or unverifiable — a candidate with no
pull request, a truncated listing, or a failed read is non-comparable, because "could not check" is not
"clean" (L2). The brief still carries the boundary with its reason, so the delegate is told before it is
refused.

### D4 — the round records where its candidate came from

A round named a `candidateVersion` and nothing else. The chain "delegation session → PR → sha → image → scorecard
→ round" existed in four different records and was joined in none. **Landed:** `verdictOf` copies the
candidate scorecard's origin coordinates onto the round as `verdict.candidateSource` — `source`, `repo`,
`sha`, `ref`, `prNumber`, `runUrl`, `pinOverrides` — and an adopted close carries the same block. It is
derived from the candidate scorecard's own record (L3), never accepted from the caller; `source` travels
with it because it says who authored the coordinates (a `github-actions` origin is CI's word under OIDC, an
`api` origin is the submitter's).

### D5 — adoption reaches the merge

**Landed.** An adoption registers the harness version the round measured; when the proof's `candidateSource`
names a pull request, the close also records a **code debt** on the operation (`AdoptionOperation.code`:
repository, pull request, the measured head, `owed`). `POST /campaigns/:id/merge` and
`merge_campaign_candidate` pay it: the stored proof is the authority, the bytes must be registered first, the
merge runs through the workspace GitHub App asserting the measured head (GitHub refuses a moved head), and
only then is `code` marked `merged` with the commit GitHub reports — a conditional write, race-safe, riding
the `campaign.adoption_merged` fact. The chain check refuses `continues` over an adoption whose code debt is
still owed. Kept as a sub-lifecycle rather than a fourth operation state, because `completed` is about the
ISSUE and this is about the REPOSITORY. A deployment without the App answers the merge by name (404) and the
debt stays visibly owed. The merge is a governed action for the agent (approval), like a push.

## Which coding agents can be delegated today

Only a CONVERSATIONAL harness can be a delegation profile: a profile session is always a conversation, and
`create_sandbox` answers 400 for a harness that cannot resume. `ClaudeCodeHarness` carries the
`conversational` marker (`packages/harnesses/src/claude-code.ts`), and — **landed** — so does a
`CommandHarness` whose spec declares a `conversation` contract (`docs/command-harness.md`): how the CLI resumes
(`{{conversation}}` → `resume` with the previous token) and how the next token is read off its output
(`token.pattern`). So:

- **Claude Code** — through a delegation profile, as designed.
- **Codex, claude-code-router, any other CLI** — register a `command` harness with a `conversation` block and
  it qualifies as a profile's agent exactly like the built-in. A spec without the block stays one-shot and can
  still be driven through the playground's `harness` boot mode, one `submit_sandbox_task` per prompt.

## What is open, and the seam each rung closes

| rung | seam | closes |
|---|---|---|
| the round keyed on the candidate's resolved digest, so a PR-mode scorecard can be the round's candidate | a batch per round on a version minted only to be measured | D2 |
| a session lane that ENFORCES `allowlist` egress (the docker lane refuses it honestly; K8s needs a policy per session) | a delegate whose declared network the runtime cannot hold | — |

### D6 — the delegate is budgeted too

**Landed.** Rounds were bounded; the coding agent a round delegated to was not. The frame carries
`delegation {ttlSec, maxUsd?}`; a round under such a frame names its sandbox session (`delegationRunId`), and
`CampaignService.logRound` reads what that session cost off the RUN LEDGER — the TTL it was granted and the
spend it metered — refusing the round when either exceeds the budget. The session's cost is recorded on the
round as `delegation` whenever one is named, from the ledger and never from the caller. A session the ledger
cannot read is a round that cannot be logged under a budgeted frame.

### D7 — the delegate's box is the profile's

**Landed (the declaration and its carriage).** `DelegationProfileSpecSchema.network` carries the same
`NetworkPolicy` an eval case declares, and `SandboxSessionService.create` hands it to the driver's provision.
`none` for a delegate that needs no network; `allowlist` naming the repository host and the model endpoint for
one that does; absent = the runtime's default. Placement already had its axis: `create_sandbox { runtime }`
puts the session on a workspace-registered runtime rather than the control plane's docker. What is NOT landed
is enforcement on every lane: the docker driver refuses `allowlist` by name (it has no filtering network), so a
profile declaring it must be placed on a runtime that can hold it. A policy the box does not hold is not a
policy, and refusing the boot is the honest answer until such a lane exists.

## What would reopen this

- Everdict gaining an in-platform build lane. D2 rests on "never builds"; if that changes, the candidate image
  can be built from the PR inside the loop and D2's CI dependency goes away.
- A conversational `CommandHarness`. The "which agents" section is a description of today's adapters and
  expires the day one lands.
- Evidence that CI-fired origin coordinates are forged in practice. D4 records `source` so a reader can weigh
  them; if that is not enough, the round has to verify the sha against the pushed image's build attestation.

## Verification

- `code_evolve` is a store entry a workspace copies (first-party skill test), names every tool it drives, and
  carries its round-brief reference file.
- `verdict.candidateSource` is pinned by the campaign service suite: derived from the candidate scorecard's
  origin, absent when the origin says nothing, carried onto an adopted close, and never read by the gate.
