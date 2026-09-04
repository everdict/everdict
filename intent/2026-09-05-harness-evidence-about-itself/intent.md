# Intent: the harness holds no evidence about itself

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

Two gaps, and they are the same gap seen from opposite ends: everything this harness knows, it knows about
the code. It knows nothing about itself.

**Its wiring is unchecked.** The push gate is the enforcement layer for both ledgers — CI parity and, since
this week, the agent evals. It is wired in `.claude/settings.json`, an editable file in the tree, and **no
check reads it**: `grep -l settings.json scripts/check-*.mjs` returns nothing. What stands in for a check is
a sentence in `CLAUDE.md` — *"Never work around it (no stamp forging, no pushing outside the tool)"* — which
is prose, in a repository that has recorded a dozen times what happens to a law kept as prose. Deleting the
hook block is a two-line edit that every gate stays green through, and the next push is ungated with nothing
saying so. The gate that guards everything else is the one thing guarded by good intentions.

**It measures nothing over time.** `evals/.results/` is overwritten on every run, so the eval pass rate — the
one leading indicator this harness actually produces — has no history. That closes a door: a control band
needs a rolling baseline, and a baseline cannot be collected retroactively. Every run that goes by without
being recorded is a run that can never be part of one. The measurement rules this project wrote down say
exactly that, and the project is not following them.

## Proposed outcome

The gate's decision is a pure function with a truth table a check can drive, and the check also refuses a
tree whose `.claude/settings.json` has stopped wiring the hook. Deleting the wiring turns CI red for the
stated reason.

Every full eval run appends one line to a durable history — date, model, per-case outcome, cost — so that in
some weeks there is a baseline for a band to read, and in the meantime a trend a person can look at.

## Affected users and systems

`scripts/hooks/pre-push-gate.mjs` (the decision becomes a function), a new pure module beside it, a new
`scripts/check-guardrails.mjs`, `evals/run.mjs`, `ci.yml` + `scripts/ci-local.mjs`, `.claude/rules/ci.md`,
skill `ci`, `evals/README.md`.

## Constraints

- **No bypass may be introduced to make the gate testable.** An env var pointing the ledger elsewhere would
  make the check easy and the gate forgeable. The decision is separated from the fact-gathering instead: the
  check drives the decision over facts it constructs, and the ledger path stays where it is.
- The history is append-only and must survive `--only` runs without polluting the baseline — a partial run
  answers about one case, and a band will read only full ones.
- Nothing may make an ordinary push slower.

## Open questions

- How many runs before a band is honest? Not answerable now; the point of this change is to be able to ask it
  later. Carried into whichever intent builds the band.
