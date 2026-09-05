# Intent: close what can be closed, and declare what cannot

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

The eighth diagnosis puts all sixteen plays at L3 or above and the grade at G2. What holds it there splits
cleanly in two, and the two halves need opposite treatments.

**Work that is simply not done yet.** The eval suite has thirteen cases against a stated baseline of twenty to
fifty. Seven of eight scan scopes have never been read — `--status` says NEVER for each, which is the honest
answer and not a good one. The incident-to-eval route exists as a paragraph in `lessons/README.md` and as
nothing a machine checks. A spec records no version of the policies it was written under, so a spec that
predates a rule change cannot be told from one that followed it. And nothing states a concurrency ceiling,
which the article ties to review capacity rather than to taste.

**Clauses this deployment cannot satisfy.** Branch protection requiring a code owner needs a second person.
Managed settings need MDM. Per-environment autonomy tiers and a rehearsed rollback need something deployed.
Four of the eight containment-drill rows need managed settings to exist. These have been mentioned in passing
in three commit messages and are recorded nowhere a reader can find them, which is the same failure as a
control nobody names: a limit that lives in prose somebody wrote once is a limit the next reader rediscovers.

There is also one observation the diagnosis surfaced that belongs with neither: **the push gate has made
eleven decisions and every one is a denial.** The drill this repository applies to every other control — see
it refuse, then see it permit — has never had its second half for the gate itself.

## Proposed outcome

The first half is done: cases to twenty, every scope read at least once, the incident-to-eval route mechanised,
specs stamped with the policy versions in force, a ceiling stated.

The second half is written down in one place, per clause, with what would reopen it — so the next diagnosis
reads a declaration instead of rediscovering a wall.

And the gate is observed permitting a push, once, so its allow path stops being a truth-table row.

## Affected users and systems

`evals/`, `scripts/scan/`, `scripts/design/`, `scripts/check-intent-chain.mjs`, a new check for the
incident-to-eval route, a new `docs/architecture/harness-declared-limits.md`, `.claude/rules/ci.md`, CLAUDE.md.

## Constraints

- **A declared limit is not an excuse.** Each names the clause, why this deployment cannot satisfy it, what a
  reader should not conclude from its absence, and the condition that reopens it. A declaration with no
  reopening condition is a permanent excuse.
- The incident-to-eval check must not demand an eval for every lesson. Not everything is mechanisable, and
  `lessons/README.md` already says recording that decision is itself the answer. It checks that a lesson
  which SAYS it produced an eval case actually did.
- Cases keep coming from recorded incidents. An invented case tests an invented convention.
- Scanning all eight scopes is one statement about each at one time under one model, not a clean bill.

## Open questions

- Is twenty the right number, or is it the article's number? Unknown until a case fails for a reason none of
  the others would have caught. Recorded rather than guessed.
