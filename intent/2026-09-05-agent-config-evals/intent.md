# Intent: the configuration that steers the agent gets the regression testing the code gets

Author: maintainer (via AI-native SDLC audit). Status: shipped

Shipped: a045d54a69b9d389d4045439a470104c61c6bf50

## Problem

This repository's doctrine is that a law written as prose gets broken by the person who wrote it. It is
stated in `.claude/rules/ci.md` a dozen times over, always with the incident attached: `authz-optional` exists
because the prose version failed three times in two hours, all by its author, each failure inside the fix for
the previous one. `guarded-doubles`, `unwired-capabilities`, `untrusted-ingress`, `option-forwarding` and
`guard-siblings` each carry the same story. The answer every time was the same: stop stating it, enforce it.

There is exactly one thing that doctrine has never been applied to, and it is the doctrine's own carrier —
**the configuration that steers the agent**. `CLAUDE.md` (151 lines), 28 rules and 19 skills change with no
behavioural regression test whatsoever. What exists checks their SHAPE: `docs-check` asks whether the paths
and symbols they name still exist, `convention-harness` asks whether a rule's glob still matches live code and
a skill still carries a description. Both are real and both are structural. Neither asks the only question
that matters after a skill is edited — *does the agent still do the work to the same standard?*

The nearest thing this repository ever had was `pnpm protocol-mutations`, and two facts about it matter here:
its subject is the PRODUCT's code, never the agent's configuration, and it was removed from CI on 2026-08-29
because ninety minutes on every push was a cost not worth paying. So the product is mutation-tested and the
agent configuration has never been tested at all.

The failure this permits is silent by construction. A skill edit that stops the skill triggering, a rule whose
wording drifts from what it meant, a `CLAUDE.md` line deleted as redundant — every one of them leaves every
existing gate green, and the only witness is the next session that quietly does the wrong thing.

## Proposed outcome

A committed suite of eval cases, each a real recorded failure from this repository's own history, that runs
non-interactively against the agent configuration and fails when the configuration stops carrying the lesson.
It runs on any change to `CLAUDE.md` or `.claude/**`, because that is the configuration under test, and on a
schedule, because a model change moves the answer without any commit at all.

The suite must survive its own removal drill: deleting the rule a case is about makes that case go red. A case
that stays green when its subject is deleted is a lost case, and this repository has paid for that lesson too.

## Affected users and systems

`CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**` — the configuration under test. A new `evals/` tree, a
new workflow, and the local gate. No package or app source changes.

## Constraints

- Cases come from failures that actually happened here and are already written down. An invented case tests
  an invented convention.
- Deterministic checks first. A model judge is a second engine whose disagreement is indistinguishable from a
  regression, and this repository already refuses that shape elsewhere.
- Cost is bounded by the trigger, not by hope: path-filtered, not on every push. `protocol-mutations` was
  removed for exactly this reason and the replacement must not repeat it.
- A case that cannot run must FAIL rather than skip. A skipped trust scenario is a failed certification here;
  an eval suite that reports green because it never ran would be strictly worse than none.
- English only, like everything else in the repository.

## Open questions

- Should a failing case block the merge, or report? (Resolved in `plan.md`: block, with the pass threshold in
  the suite itself, because a report nobody reads is the state we are already in.)
- Where does the API key come from in CI, and what happens on the first run before it exists?
