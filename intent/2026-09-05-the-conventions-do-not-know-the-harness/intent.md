# Intent: the conventions do not know about the harness that now enforces them

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

Six new controls landed this week — the intent chain, the agent-eval suite, the guardrail check, the scanner
vocabulary check, the review gate, the release authorization, the band watcher. Every one of them is recorded
in `.claude/rules/ci.md`, and almost nowhere else. A sweep says it plainly:

- `REVIEW.md` — the review policy the gate applies to every product push — is named by **nothing** under
  `.claude/`. The skill that has failed twice now has an enforcer and does not mention it.
- skill `foundation`, the one CLAUDE.md says to read FIRST, mentions none of it.
- skill `documenting` answers "doc, rule, or skill?" over a tree that has since grown `intent/` and
  `releases/`, two artifact layers its decision procedure cannot place.
- skill `testing` describes how this repository tests and does not know `evals/` exists.
- skill `evaluation` owns the word "eval" for the PRODUCT's scoring domain, while `evals/` now means the
  agent-configuration suite. Two things with one name, in one repository, is how a reader ends up in the wrong
  one.
- `docs/README.md` indexes every document and reaches neither `intent/` nor `releases/`.

This is the failure this repository already named for rules: *a rule pointed at moved code is not a weak rule
but an ABSENT one, and it fails silently.* Here it is one turn further out — the conventions are not pointed
at anything wrong, they simply stop before the part that now decides whether a push happens. A reader who
follows `foundation` and `documenting` faithfully will not learn that a review is required, that an intent
precedes a plan, or that a tag needs an authorization.

## Proposed outcome

Every layer that a reader is told to start from names the controls that now apply to them, and the two new
artifact layers have a place in the procedure that decides where knowledge goes. The word "eval" is
disambiguated where both meanings live.

## Affected users and systems

`CLAUDE.md`, `docs/README.md`, skills `foundation`, `documenting`, `testing`, `evaluation`, `code-review`.
No behaviour changes.

## Constraints

- **Pointers, not copies.** `.claude/rules/ci.md` is where these controls are recorded; a second full
  description is a second thing to keep true, and `documenting` already says that the same knowledge in two
  layers has already diverged.
- CLAUDE.md is a map, and its size is load-bearing. What goes in is what changes what a reader DOES.
- No new rule file. These are all existing layers gaining a sentence.

## Open questions

- Does `intent/` belong in skill `documenting`'s four kinds, or beside them? It is not a doc, a rule or a
  skill; it is a request. Answered in the change: beside, with the test that separates them.
