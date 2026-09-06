# Intent: four eval cases pass a wide assertion, so they measure nothing — found by the first honest drill-all

Author: maintainer (via AI-native SDLC audit, 2026-09-06). Status: shipped

Shipped: ad1b6c97

## Problem

The drill ledger and `--drill-all` landed, and the first drill-all that could not lie (an errored agent call
is inconclusive now, not a false red) ran six cases before a rate limit stopped it. Five of the six that ran
went **green** — they pass with their lesson removed — and only `biome-write-is-not-evidence` went red. The
green ones are `allowlist-rebuild-eats-fields`, `authority-before-effect`, `backends-never-run-the-harness`
and `ci-local-before-push` (the fifth, `madge-exit-code`, was retired the same day for the same reason).

Widening their `subject` lists did not fix them, which rules out the leaked-lesson cause the exclusivity
check already closes. The cause is the assertion. Each is a wide alternation that a correct GENERIC answer
satisfies without the specific lesson:

- `allowlist-rebuild-eats-fields` — `mustMatch: rebuild|allowlist|QueueEntry|runOne|forward`. Asked what to
  watch when adding a field to `DispatchOptions`, any answer that says "forward the field" matches, and
  forwarding a new field is the obvious generic advice.
- `authority-before-effect` — `authority|durable|proof|before (the )?effect|record.*first`. "Authority before
  effect" is a famous principle; an agent recites "record it first" from general knowledge.
- `backends-never-run-the-harness` — `job-runner|dispatch|__EVERDICT_RESULT__|sentinel`. Naming "dispatch" is
  enough, and dispatch is what anyone would say a backend does.
- `ci-local-before-push` — `ci[:\- ]?local`. The regex matches "run local CI", generic push hygiene.

This is the exact shape skill `code-review` pass 5 names: an existence check standing where a discriminating
one was meant. A prompt a correct generic answer satisfies cannot test a specific lesson — the same finding
`biome-write-is-not-evidence`'s own `why` already records, which is why that one was rewritten and now drills
red.

## Proposed outcome

Each of the four either asserts on an artifact ONLY this repository's lesson would name — a specific symbol,
a specific command, a named failure — so a generic answer misses, or it is retired with its reason (the case
tests recall, not steering). The bar is the drill: after the change, `--drill <id>` goes red, verified, and
the certificate is recorded. Because the fix is per-case and each needs a real agent run to confirm the
drill flips, this is a change with a real budget, not a mechanical edit.

## Affected users and systems

`evals/cases/{allowlist-rebuild-eats-fields,authority-before-effect,backends-never-run-the-harness,ci-local-before-push}.json`,
`evals/RETIRED.md` for any that retire, `evals/history.jsonl` (the drill certificates), and — once every
remaining case drills red — the stamp coupling deferred in `intent/2026-09-06-what-the-second-audit-found/`
can finally land, which is the whole reason this matters.

## Constraints

- **Narrow the assertion toward the lesson, not away from every generic answer.** Pass 5's other half: a
  refusal that is too tight removes a legitimate answer silently. The target is an artifact the lesson names,
  not a longer blocklist.
- **Verify each with a real drill.** A reworded assertion that is not drilled is the same unmeasured claim in
  a new spelling.
- The 14 cases the rate limit left inconclusive are not known-good; a full clean `--drill-all` is owed before
  the stamp coupling lands, and this change is a prerequisite for it, not a substitute.

## Open questions

- Which of the four can be made discriminating, and which are testing recall of a technical detail and should
  retire like `madge-exit-code` and `scanner-blind-to-composition-root` before them?
- Is `authority-before-effect` salvageable at all, given the principle it names is genuinely general
  knowledge? A case over a live symbol (as `untrusted-ingress-authorship` replaced `authz-optional-reflex`)
  may be the honest replacement rather than a tighter regex.

## Shipped — and the answer was not the one this intent expected

Shipped in `ad1b6c97`. This intent guessed the cause was a wide assertion and proposed narrowing. That guess
was wrong, and the way it was found wrong is the part worth keeping: narrowing each assertion to a private
symbol, then running the case in BOTH states, showed the case passing normally (so the assertion was not too
tight) and STILL passing when drilled (so the lesson was not the cause). The answers were reachable by
grepping live source, which every case is allowed to do.

All four are retired, not repaired: three for the codebase-answers-it reason, `authority-before-effect` for
the sibling one (the principle it names is general knowledge). The principle they cost is in `evals/README.md`
and `lessons/2026-09-06-the-code-already-knew-the-answer.md`.

Two threads left open rather than closed:
- **rule `protocol` L1 has no eval case.** The honest replacement is a case over a live symbol whose return
  type carries the proof, in the shape that replaced `authz-optional-reflex` — not a reworded regex.
- **The suite is 15 cases, below the 20–50 baseline**, and eleven of them have never been drilled honestly.
  The next clean `--drill-all` may retire more, and new cases should be written against the new principle
  rather than backfilled to reach a number.

