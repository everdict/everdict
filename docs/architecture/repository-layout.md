---
kind: decision
title: "Repository layout — the root holds products, docs hold records, and rules stay thin"
status: accepted
updated: 2026-09-15
anchors: [scripts/check-docs.mjs, scripts/check-intent-chain.mjs, scripts/hooks/gate-decision.mjs, scripts/check-controls-documented.mjs]
---
# Repository layout — the root holds products, docs hold records, and rules stay thin

> **What this decides.** The repository root holds what ships and the tooling around it; every document,
> including the harness's own records, lives under `docs/`; every harness tool lives under `scripts/`. The
> root went from 19 tracked directories to 11. In the same change the two rules that had outgrown the push
> layer were cut back to what must be in mind at the keyboard, and their incident bodies moved to where a
> reason is supposed to live. Decided by the maintainer on 2026-09-15.

## What moved

    intent/                      → docs/sdlc/intent/
    lessons/                     → docs/sdlc/lessons/
    releases/                    → docs/sdlc/releases/
    findings/DISPOSITIONS.md     → docs/sdlc/finding-dispositions.md
    scans/DISMISSED.md           → docs/sdlc/scan-dismissals.md
    docs/architecture/harness-{declared-limits,observability,drill-certificates}.md
                                 → docs/sdlc/{declared-limits,observability,drill-certificates}.md
    evals/                       → scripts/evals/
    fixtures/                    → packages/contracts/fixtures/     (both consumers already depend on contracts)
    datasets/webvoyager-mini.jsonl → examples/benchmarks/          (beside webvoyager-sample.jsonl)

    .claude/rules/ci.md          714 lines → 50;  the bullets moved verbatim to docs/sdlc/gates.md
    .claude/rules/protocol.md  1,231 lines → 185; the laws and the definition of done stayed, the 46
                                 corollaries moved verbatim to .claude/skills/protocol/references/corollaries.md
                                 and the rule lists each by its heading
    CLAUDE.md                  15.0 KB → 13.3 KB, with a layout section the old one did not have

All 28 rules together went from 3,307 lines to 1,599.

## Why

**Six root directories were one concept.** `intent/`, `lessons/`, `releases/`, `findings/`, `scans/` and the
three `harness-*` pages are all the harness remembering something, and a reader had to learn each location
separately — `CLAUDE.md` carried a section whose only job was listing them. Two of those directories held a
single file. `docs/sdlc/README.md` is now the one place that explains them.

**A rule is pushed, so its size is paid on every edit.** Skill `documenting` and `.claude/skills/README.md`
both say a rule is thin (~20–40 lines) and a reason is a record. `ci.md` is injected by `**/*` — every file
anyone reads or edits — and it had become 714 lines of incident history, largely because
`pnpm controls-documented` demanded every control be explained there. `protocol.md` had become 1,231 lines
for the same reason one layer down. The harness was violating the size budget it wrote for itself, and it was
the two largest rules that did.

## What was rejected

- **Harness records under `.claude/`.** `.claude/**` is the configuration that steers the agent, and a push
  that changes it owes an `pnpm agent-evals` run (`CONFIG_PATHS` in `scripts/hooks/gate-decision.mjs`). Every
  intent, lesson and ledger line would have cost a model run to push, for text that steers nothing.
- **`evals/` under `docs/sdlc/`.** It is a runner, JSON cases and an append-only history — code and data, not
  documents — and `scripts/` already holds `bands/`, `scan/`, `review/`, `design/` and `telemetry/`.
- **`docs/harness/` as the name.** It was the first name this change used, and it collides with the product:
  in Everdict a *harness* is the agent under test, and `docs/command-harness.md`, `docs/service-harness.md` and
  six `docs/architecture/harness-*` pages sit beside it. `sdlc` names the role and nothing in the product.
- **Flat `docs/intent/`, `docs/lessons/`, …** The `docs/` root already holds 24 loose pages. Five more
  maintainer-process entries beside the product reference would make the tree harder to read, and the paths
  a gate scopes by would grow from one prefix to five — an agent searching for product knowledge excludes
  `docs/sdlc/**` in one pattern, and those records grow with every change (69 intent and lesson files were
  added in the first half of September alone).
- **Relocating `docs/architecture/` by kind while the tree was being moved.** Still rejected, on the same
  argument as [docs-site-removal.md](docs-site-removal.md), and the count has grown: 1,153 citations of
  `docs/architecture/**` across the tree, 546 of the citing files under `packages/` and `apps/`. The three
  `harness-*` pages moved because they had 41 citations between them and belong to the harness.
- **Moving `clients/` and `plugin/`.** `.claude-plugin/marketplace.json` resolves `./plugin` from the root, so
  moving it changes what every installed marketplace fetches. `clients/python` is a Python package with its own
  `pyproject.toml`, and `packages/*` is the pnpm workspace glob — a non-pnpm directory there would read as a
  workspace to every tool that walks it. Both are shipped products, which is what the root is for.
- **`REVIEW.md` into `docs/sdlc/`.** `scripts/review/run.mjs` tells the reviewer to read it at the root of
  the worktree, and a policy file at the root is what review tooling looks for. It is one file, not a directory.
- **Deleting the incident history to shrink the rules.** Every bullet is the reason a gate exists and the ways
  it has been wrong; that is exactly the record `docs/` is for. It moved, verbatim, and nothing was dropped —
  `docs/sdlc/gates.md` names every control in `package.json`, which `pnpm controls-documented` now checks.

## What the move had to repair, and would break again

- **`pnpm intent-chain` asks git which commit introduced each `intent.md`.** Without `--follow`, the oldest add
  of every file after a directory move is the MOVE, so every `From:` sha reads as wrong and every `Shipped:` as
  earlier than its plan. Driven red in a throwaway clone with the move committed (the stated reason, on every
  change directory), green with `--follow`. Anyone asking git by hand has to follow renames too.
- **`pnpm docs-check` would have held records to the document contract.** Intents, lessons, authorizations and
  ledgers carry no `kind:` because their shapes are owned by other gates; `RECORDS` in the check exempts them
  from the index, kind and cited-path checks and keeps them to resolving links. And a GitHub permalink pinned
  to a commit (`blob/<sha>/intent/README.md`) is now resolved AT that commit — it was true when written and
  stays true; only `blob/main/…` is a claim about today's tree.
- **Finding dispositions are joined to reports by the path they cite**, so historical entries still name
  `evals/run.mjs`. That is correct and must not be "fixed".
- **The agent-eval suite's leak check** scans every tracked text file for a case's needles. The trust-skip case
  now lists `docs/sdlc/gates.md` as a subject, because the drill has to remove the lesson from where it moved.
- **The push hook's paths** — `CONFIG_PATHS` now names `scripts/evals`, and the release arm reads
  `docs/sdlc/releases/<tag>.md` at HEAD. It also names `docs/sdlc/gates.md`: the trust-skip lesson used to
  live in `ci.md`, inside the eval arm, and moving its text to a document outside the arm would have let an
  edit delete what the case measures without owing an eval run. A moved lesson keeps its guard.

## What is lost

- **Link rot outside the repository.** `blob/main/intent/…` URLs in issues and PR bodies stop resolving. Pinned
  permalinks keep working.
- **The case law is no longer pushed in full.** A session editing a store used to receive every corollary's
  incident on every edit; it now receives the heading — "a conditional write inside a transaction is not a
  successful one" — and the body is one read away in skill `protocol`. That is the trade the push/pull split
  exists to make, and it is a real one: an agent that never pulls the skill sees less than it did.
- **`git log` over the moved paths** stops at the move unless asked to follow.
- **The next push owes a fresh `pnpm agent-evals` run**, because the configuration digest changed.

## What would reopen it

- **An agent-eval drill showing a corollary is no longer applied** because only its heading is pushed. That is
  the measurement that would argue a body back into the rule — per corollary, not wholesale.
- **A rule growing past ~200 lines again.** The budget is `.claude/skills/README.md`'s; the push layer should be
  measured the way everything else here is.
- **A new top-level directory.** It is a change to this decision, and it needs its reason written here.
- **Documentation becoming a product surface for people outside the repository** — the reopening condition
  `docs-site-removal.md` already names, which would also reopen where `docs/sdlc/` belongs.
