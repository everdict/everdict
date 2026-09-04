# Intent: four plays still wait for somebody to start them

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

Six rounds of work moved this harness from nothing-refuses to twenty-seven gates, a closed detection loop and a
scan that reads code nobody touched. A re-diagnosis says the whole thing is held at the same rung by four
plays, and they share one property: **the artifact exists, and a person still has to pick it up.**

- **An accepted `intent.md` triggers nothing.** Ten change directories, nine plans, zero specs. The design pass
  the article puts between them has never run, because nothing asks for it and nobody remembers to.
- **Session telemetry is opt-in**, so the three indicators only a session can answer — concurrent sessions,
  steering against waiting, tool decisions — are collected when somebody exports the recipe by hand. A quiet
  week and an uninstrumented week look identical.
- **Nothing invokes the watcher.** `pnpm watch-bands` computes bands correctly and waits to be typed. A control
  band that only reads when asked is a dashboard.
- **The judgement step on a red gate is manual.** `pnpm triage` reads the failing scanner's own header and
  reports, and the person who could most use it is the one who has to remember it exists at the moment
  something just went red.

Each is the same shape the whole audit was about, one level in: not a missing capability, a missing trigger.

## Proposed outcome

The design pass has a rotation, so running it needs no decision about which intent. Telemetry is on by default,
because it costs nothing when nothing is listening — verified, not assumed. The bands are read on every full
gate run, which is the cadence a push already has. And a red bespoke gate explains itself without being asked.

## Affected users and systems

`.claude/settings.json`, a new `scripts/design/`, `scripts/ci-local.mjs`, `scripts/check-intent-chain.mjs`,
`package.json`, `.claude/rules/ci.md`, `intent/README.md`.

## Constraints

- **Telemetry may not make a session noisy when no sink is listening.** Measured before deciding: a session
  with the full recipe and nothing on the port produced 157 bytes of unrelated stderr. Conversation content
  stays off.
- **The gate must not become slower or more expensive for a green run.** Bands are read in dry-run, which is
  file reads and arithmetic; triage costs a model call only when something is already red.
- **The design pass writes a spec into the working tree and commits nothing.** A machine may propose; the
  intent chain then applies to that file exactly as to a person's.
- An accepted intent with no spec is REPORTED, never failed. Not every change needs a design pass, and a gate
  that insists otherwise gets routed around.

## Open questions

- Should the design pass be triggered by the commit that accepts an intent rather than by a rotation? A hook
  on every commit is a tax on every commit; the rotation is the cheaper shape and this is the first place it
  has been tried on a stage rather than on a scan.
