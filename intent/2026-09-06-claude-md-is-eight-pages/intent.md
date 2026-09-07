# Intent: CLAUDE.md is eight pages, and the playbook's limit is one

Author: maintainer (via AI-native SDLC audit, 2026-09-06). Status: shipped

Shipped: 6aa61248

Design: none — the design question this change would ask ("which layer does each sentence belong in?") is
already answered by skill `documenting`, and the move is bounded by a fact a design pass cannot improve on:
the eval suite names the exact sentences that must stay. A spec here would restate `documenting` and the
case list.

## Problem

`CLAUDE.md` is 184 lines, 4,123 words, 33 KB. Every session loads all of it before reading a single line of
the task. The AI-native SDLC playbook's limit for this file is under a page, on the argument that anything
stale in it spends context for nothing and a long file flatters the repeat-mistake metric while starving the
context that would prevent the next one.

Most of the length is the module map: one dense paragraph per package under "Architecture", much of it a
restatement of what `.claude/skills/foundation` and the per-package rules already carry, and some of it a
changelog ("the former `@everdict/{core,suite,run-case,billing}` packages were folded…").

The audit scored play 5 at L4 anyway — the file is gated by the eval stamp and by `docs-check`, and mistakes
enter it on their second occurrence — and flagged the length as the counter-metric the rung cannot see.

## Proposed outcome

`CLAUDE.md` holds what every session needs before its first tool call: the read-first and review-first rules,
the five commands and the push gate, the protocol laws by name, the language policy, the change chain, and a
map of where the rest lives. The per-package prose moves to the foundation skill (pulled by name) and the
per-package rules (pushed by glob), where it already half-lives. The eval suite still passes: every case whose
`subject` names `CLAUDE.md` either still finds its lesson there or is re-pointed at the layer the lesson moved
to, and its removal drill is re-run.

## Affected users and systems

`CLAUDE.md`, `.claude/skills/foundation/`, `.claude/rules/*.md`, `evals/cases/*.json` that name `CLAUDE.md`
as a subject, `scripts/check-docs.mjs` and `scripts/check-convention-harness.mjs` (both read the file).

## Constraints

- **No lesson may be lost in the move.** A sentence that leaves `CLAUDE.md` lands in a layer that is loaded
  when the mistake it prevents would be made — a rule for keyboard-time mistakes, a skill for design-time
  ones — and the eval case that guards it is re-drilled after the move.
- The module map is not deleted; it is pulled instead of pushed.

## Open questions

- Which lessons in `CLAUDE.md` are there because acting on the wrong belief does damage BEFORE any rule is
  read? Those stay. `evals/RETIRED.md` records one such judgement already (`scanner-blind-to-composition-root`).
- Is one page the right number for a monorepo with nineteen packages, or is the right number "what the eval
  suite proves is load-bearing"?

## Shipped

Shipped in `6aa61248`: 189 lines / 4,224 words → 165 lines / 2,124 words, just under half. The block moved was
the 56-line `## Architecture` section, chosen by measurement rather than taste — not one of its lines is a
sentence an eval case holds as a subject, which was verified before the edit and re-verified after.

The order the plan fixed held: the eight packages CLAUDE.md documented and the foundation reference did not
(`llm`, `datasets`, `images`, `agent-runtime`, `sdk`, `otel`, `apps/agent`, `apps/desktop`) were written into
`.claude/skills/foundation/references/architecture.md` FIRST, so nothing was deleted before it existed in the
other layer.

What stayed is what a session must not get wrong before it looks anything up: the spine diagram, the
layer-spine sentence, "reverse imports are bugs", the intra-package layout rule, the Backend-vs-Driver
distinction, and the deliberate-interfaces deviation. The map itself is pulled now — by skill `foundation`,
and by the per-package rule a `paths:` glob injects while you edit that package.

**The falsifier stands and has not fired.** If a later review finds a layering violation whose cause is the
missing map, this change is the suspect. Nothing of that shape has appeared in the two reviews since.

