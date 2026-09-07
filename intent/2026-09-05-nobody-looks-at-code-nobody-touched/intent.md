# Intent: nobody looks at the code nobody touched

Author: maintainer (via AI-native SDLC audit). Status: shipped

Shipped: 20e6ad53db9b5dac5b909d528f3f8b2659515259

## Problem

Every control this harness has is change-scoped. `pnpm review` reads a diff. The gates read what a commit
touched. `pnpm agent-evals` fires on configuration that changed. All of them are blind to the same thing:
**code nobody has touched.** A file written eleven months ago, correct under the model and the conventions of
that week, is never looked at again — and both halves of that statement go stale. The code around it changed,
and the reader got better at finding what the old one missed.

`gitleaks` runs over all history on every push, and it is a deterministic secret scanner. It answers one
question well and is not built for the context-dependent kind: a bound composed with an unbounded neighbour, a
platform field riding on a producer document, a guard exported and called by nothing. Those are exactly the
defects this repository's own history is made of, and every one of them was found by a person happening to
look.

There is a second, smaller absence beside it. When something goes wrong here, what is learned lives in a
commit message and in the header of whichever check was written afterwards. That is a good record of the
FIX and no record of the incident: what was believed at the time, what made it invisible, what would have
caught it earlier. Those are the sentences a future scan or eval case gets written from, and they are being
reconstructed from diffs every time.

## Proposed outcome

A scan that is not change-scoped: it takes a scope, reads it whole, reports findings with a confidence, and
records when that scope was last looked at — so "when did anyone last read this directory" is a query rather
than a guess. Scopes rotate, so the least-recently-read one is always the next one.

A place for what an incident taught, written once, where the next scan and the next eval case can read it.

## Affected users and systems

A new `scripts/scan/`, a new `lessons/`, `package.json`, `scripts/bands/bands.yaml`, `.claude/rules/ci.md`,
`docs/architecture/harness-observability.md`, `docs/README.md`.

## Constraints

- **A scan is a statement about a scope at a time, under a model.** All three go in the record, or a later
  reader cannot tell a clean scope from an unscanned one.
- **Findings carry a confidence and are never auto-applied.** Everything this scan finds enters the tree the
  way everything else does: as a change that meets the gates. A scan with a route to the code would be the
  one control here that writes without review.
- It must not become another thing that only runs when someone remembers. Staleness is reportable and the
  rotation picks the next scope, so "run the scan" needs no decision about where.
- A lesson is written by a person. A machine can file an `intent.md`; only somebody who was there can say what
  they believed at the time.

## Open questions

- Should a stale scope block a push? Not yet. The scan reads code the push does not touch, and refusing a
  change over an unrelated directory's age is how a control gets routed around.
