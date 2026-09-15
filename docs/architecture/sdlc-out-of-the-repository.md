---
kind: decision
title: "The development process leaves the repository — only the product stays"
status: accepted
updated: 2026-09-15
anchors: [scripts/check-docs.mjs, scripts/check-convention-harness.mjs, CLAUDE.md]
---
# The development process leaves the repository — only the product stays

> **What this decides.** Everything this repository kept about HOW it is developed — requests and their specs
> and plans, lessons, release authorizations, review policy and findings, the gate catalog, the push gate, the
> agent-configuration evals, and the process skills and agents — is removed. What remains is the product: its
> code, its product documentation, the conventions of that code, and the checks that read the code. The
> knowledge the removed machinery produced is meant to accumulate in Everdict instead, through the Everdict
> plugin (`docs/architecture/development-system-of-record.md`), and that will be verified by developing this
> product with Claude Code or Codex through Everdict. Decided by the maintainer on 2026-09-15. Supersedes
> [repository-layout.md](repository-layout.md), whose central claim — the records live under `docs/sdlc/` —
> this reverses.

## What was removed

    docs/sdlc/                  78 files — 34 change directories (intent/spec/plan), 10 lessons, release
                                authorizations, the finding and scan-dismissal ledgers, the gate catalog,
                                declared limits, harness observability, drill certificates
    REVIEW.md                   the review policy
    the push gate               pnpm ci:local, pnpm ci:commits, the PreToolUse hook and its decision module,
                                the stamp ledgers it read, and pnpm guardrails, which checked its wiring
    process gates and tools     intent-chain · design · lesson-evals · fix-proof · doc-anchors ·
                                controls-documented · review · findings · scan · watch-bands · triage ·
                                telemetry (and the session hook and env that started it) · agent-evals
    .claude/                    rule `ci`; skills `code-review`, `documenting`, `ci`; agents gate-triage,
                                liveness, verifier

Every one of them is readable at `ddecfe1a` (after the records were gathered under `docs/sdlc/`) and at
`a958dc36` (before, at the repository root).

## What stays

The product's code checks, each runnable on its own: lint, typecheck, test, build; the protocol scanners
(`swallowed-reads`, `untrusted-ingress`, `authz-optional`, `gated-doors`, `guarded-doubles`, `unwired-*`,
`option-forwarding`, `guard-siblings`, `gate-order`, `constructed-casts`, `grader-collapse`, `source-bytes`,
`mutation-leak`, `import-cycles`), `cone`, `web-imports`, `web-reach`, `migrations`, `artifact-frame`,
`plugin-manifests`, `python`, `language-policy`, `docs-check`, `convention-harness`, `scanner-watches`; the trust
suite (`trust-fast`, `trust-full`, `trust-certified`) and `protocol-mutations`. The rules and skills that describe
this code. The product documentation, including its design records.

## Why

The maintainer's rule for a code repository is that it carries the product and nothing about the work around
it. The removed machinery was that work: per repository, per person, and in files — the three properties the
proposal names as the reason the development record belongs in a service. Keeping it here while building the
service would give every session two places to put what it learns, and the experiment that follows — does
knowledge accumulate in Everdict when a session develops this product through it — could not tell which one
did the work.

## What was rejected

- **Keeping a code-quality pipeline and push hook.** Offered and declined by the maintainer: `ci:local` plus a
  hook requiring it green before a push, with only the process arms removed. The push gate is part of the
  process being moved out, not part of the product.
- **Keeping the review skill.** Offered and declined for the same reason: how a change is reviewed is
  methodology, and methodology is what the Everdict seed is proposed to carry.
- **Keeping `docs/sdlc/` until Everdict can hold it.** That is the order the proposal suggested. The maintainer
  chose the clean baseline instead: the verification needs a repository with nowhere local to put knowledge.

## What is lost, said plainly

Until Everdict provides them, none of these properties is enforced anywhere:

- **Nothing refuses a push.** There is no CI and no local pipeline; a red commit can reach `main`.
- **Nothing proves a fix's test was red before the fix**, reviews a change, authorizes a release tag, orders a
  plan after its request, or asks the change that makes a product document false to update it.
- **The agent's own configuration has no regression test.** `CLAUDE.md`, rules and skills can lose a lesson and
  nothing notices.
- **The records are history, not a working set.** Dated requests, lessons and ledgers are no longer in the tree
  a session reads; they are in git.

## How this will be verified

Develop this product with Claude Code or Codex through the Everdict plugin, and read the Everdict workspace
afterwards: the requests the work answered, the decisions and what they rejected, the lessons, the review
findings, and the documents a change made false — each present, attributed, and linked to the commits that
carried the work. What the repository gains in the same period is code and product documentation only.

## What would reopen it

- **The verification finds knowledge that does not reach Everdict** — then the plugin loop is not doing its job,
  and the choice is to build it or to bring the local record back.
- **A red commit on `main` breaks the product** before Everdict enforces anything — then a local pipeline comes
  back first, as a product check rather than a process gate.
