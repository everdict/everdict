# Intent: take every play to its ceiling, and say where the ceiling is

Author: maintainer (via AI-native SDLC audit). Status: shipped

Shipped: e9278fa1c296d2bbe6dda3d39ccb286d2e216d9d

## Problem

Four L4 clauses are unbuilt and one is unbuildable-by-choice, and the audit currently reports all five the same
way: as a play at L3. That flattens two different facts into one number.

**Unbuilt, and cheap.**

- An intent may be `rejected` and say nothing about why. The accept/reject decision is the Plan stage's gate,
  and half of it currently leaves no record — a rejected idea in the tree with no reason is the same as a
  deleted one, except it also looks like a decision.
- A spec's "Areas of concern" is the point of the design pass — *"an empty one is suspicious"* — and nothing
  reads it. A plan can be written against a spec whose concerns are all open, which is the exact sequence the
  article puts a gate in front of.
- The permission surface is an allow list with no deny list. Every session in this repository can read
  `.env`, `~/.ssh` and `~/.aws/credentials` through the file tools and reach any host through `curl`. Nothing
  in the article's threat model justifies that; the allow list pre-approves the safe inner loop and was never
  paired with the half that refuses.
- A scan finding can be triaged and forgotten. There is no record of a dismissal, so the next scan reports it
  again as new and the ledger's downward trend means nothing.

**Unbuildable by CHOICE, which is not the same as blocked.** The play `plan mode` reaches L4 when an
implementation with no `plan.md` is refused. This repository deliberately does not want that:
`intent/README.md` says *"a one-line fix does not need one"*, and a gate that insists otherwise would be
routed around within a week. That is a decision, not a wall, and `harness-declared-limits.md` currently has no
shape for it — every entry there is blocked by something missing.

## Proposed outcome

The four are built. The fifth is declared as a **chosen** limit, in a section that keeps it visibly distinct
from the ones a missing person or fleet or deployment is responsible for — because the two reopen for
completely different reasons.

And the audit gains the vocabulary it has been missing: a play is reported at its rung AND at its **ceiling**,
the highest rung this deployment can reach. "At its ceiling" is a different statement from "at L4", and
collapsing them is how a declared limit turns into a claim.

## Affected users and systems

`scripts/check-intent-chain.mjs`, `scripts/scan/run.mjs`, `.claude/settings.json`,
`docs/architecture/harness-declared-limits.md`, a new dismissals record, `.claude/rules/ci.md`.

## Constraints

- **The deny list may not break the gates.** `pnpm ci:local` shells out to `curl` for gitleaks from inside a
  script, not through the agent's tool surface, so denying `Bash(curl *)` refuses the agent and not the gate.
  Checked before writing, not after.
- **A concern gate that refuses a plan must be satisfiable.** Each concern is marked resolved or carried, with
  a reason; "carried" is a legitimate answer and the article says so — open questions go forward into the plan.
- Dismissals are a decision, so they are COMMITTED. `.git/` does not travel, and a dismissal nobody else can
  read is a dismissal the next person redoes.
- **A chosen limit is not a blocked one and must not be filed as one.** The distinction is the entire value of
  the section.

## Open questions

- Does "at its ceiling" belong in the rubric as a rung suffix or as a separate column? Answered in the change:
  a separate statement, because a suffix on the rung is exactly the collapse this is trying to prevent.
