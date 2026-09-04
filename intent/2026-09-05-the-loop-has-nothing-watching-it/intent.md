# Intent: the loop has nothing watching it

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

Five stages of this harness now refuse things. The sixth watches nothing.

There is no detection here at all: no metric with a band, no script that notices drift, nothing that starts
work without a person deciding to start it. Every other stage was made to refuse; Maintain was never made to
**notice**. The consequence is that the loop does not close — an `intent.md` only ever appears because a human
wrote one, so the chain runs forward from a person and never returns to the queue on its own.

The materials arrived this week and are sitting unused. `evals/history.jsonl` records every suite run.
`.git/everdict-gate-log.jsonl` records every push decision with the arm that fired. Both are exactly the shape
a control band reads, and nothing reads them.

There is also a second absence, smaller and in the same family: when a gate goes red, the judgement of *why*
— flaky or real, which rung, which of the repairs its header names — is done by a person every time, including
for the failures whose scripts already state their own answer.

## Proposed outcome

A deterministic script watches the indicators this harness produces, applies banded tiers, and at the highest
tier writes an `intent.md` into the queue with no person in the invocation path. Detection stays entirely
deterministic — no model decides whether something is wrong; the model is invoked once a band is breached, and
the tier decides what it may do.

And a red gate can be triaged read-only: which rung, what its header says the legal repairs are, and whether
this looks flaky or real — reported, never applied.

## Affected users and systems

A new `scripts/bands/`, a new `scripts/triage.mjs`, `package.json`, `intent/` (as the queue), `.claude/rules/ci.md`,
`docs/architecture/harness-observability.md`.

## Constraints

- **Detection is deterministic.** Rolling mean and standard deviation over a versioned window, with the tiers
  in a versioned config. A model anywhere in the detection path makes the alarm itself unreproducible.
- **Too few samples is not "no breach".** The baseline started on 2026-09-05 and is days old. A band computed
  over three points is noise wearing a sigma, so the watcher must REFUSE to band and say how many it has —
  the same rule the trust suite applies to a scenario that skips.
- **The 3σ tier may only propose.** It writes an `intent.md`; it does not fix, and it has no route to the
  code. That is the article's boundary and this repository's.
- Triage reports and never applies. A triager that repairs is the author reviewing itself.

## Open questions

- How many samples before a band is honest? Written as a constant with a stated guess, to be corrected by the
  first time it is wrong rather than by argument.
