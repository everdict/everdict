# Intent: the agent-eval suite is enforced at the push gate, not in CI

Author: maintainer. Status: accepted

## Problem

`.github/workflows/agent-evals.yml` runs the configuration-regression suite in GitHub Actions, which means a
GitHub runner has to authenticate to Anthropic, which means an `ANTHROPIC_API_KEY` secret. Nothing about the
suite needs one: it ran five times locally against the machine's existing login, and this repository already
states that principle for the execution layer — *"for LocalDriver the harness uses the machine's existing
login (no API key)"*. The secret is a cost of the DELIVERY choice, not of the thing being delivered.

The precedent is already recorded one layer down. `pnpm protocol-mutations` was removed from CI on 2026-08-29
because ninety minutes on every push is a cost nobody keeps paying, and it became on-demand. The eval suite
has the same shape and the same trade, with one difference that matters: **the enforcement layer already
exists here.** `scripts/hooks/pre-push-gate.mjs` denies a push whose commits are not in the CI-parity ledger.
A push that changes `CLAUDE.md` or `.claude/**` can be asked for an eval stamp the same way.

Without that, the only remaining option is "run it by hand and remember", which is the advisory state this
whole suite exists to end.

## Proposed outcome

No secret, no CI cost, and the suite still enforced: a push carrying a commit that touches the configuration
under test is denied unless a green `pnpm agent-evals` has stamped the current HEAD. Pushes that leave the
configuration alone are unaffected.

## Affected users and systems

`evals/run.mjs` (writes the stamp), `scripts/hooks/pre-push-gate.mjs` (reads it),
`.github/workflows/agent-evals.yml` (removed), `.claude/rules/ci.md`, `evals/README.md`, skill `ci`.

## Constraints

- **The stamp must attest what was actually tested.** The suite runs against HEAD plus an overlay of the
  working tree's configuration, so a green run with dirty `CLAUDE.md` proves nothing about HEAD. Stamp only
  when the tested configuration is clean against HEAD, and say why when it is not — the rule `ci:local`
  already applies to the whole tree.
- **A failure to read the ledger may not read as permission.** Found while writing this: the existing gate
  does `readFileSync` on `.git/everdict-ci-ok` with no guard, so on a checkout that has never been gated it
  throws, and a PreToolUse hook that exits non-zero without a decision lets the push through. The gate fails
  OPEN on exactly the state that means "nothing here has ever been gated". Fixed in the same change, because
  adding a second ledger beside a fail-open one would compose a new bound with an unbounded neighbour.
- Nothing may make an ordinary push slower. The eval stamp is asked for only when the push carries a
  configuration change.

## Open questions

- The nightly model-swap question — *does the agent still do the work when the model changes?* — has no
  unattended answer without CI credentials. Carried forward as a named debt rather than pretended away.
