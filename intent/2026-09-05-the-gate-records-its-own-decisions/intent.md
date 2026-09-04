# Intent: the gate decides constantly and remembers nothing

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

`pnpm guardrails` proved the push gate is wired and that its decision is correct over seven constructed
facts. Neither answers the question an audit actually asks: **what did it decide, and when.** Every allow and
every deny it has ever made is gone the instant the process exits.

That costs three things at once. The gate's own leading indicator — time spent waiting per gate — cannot be
computed, so nobody can tell a control that is working from one that is merely slow. Its lagging indicator —
violations reaching the far side — has no denominator. And the deeper loss is evidential: a harness that
records only what it permitted is a success reel, and the refusals are the half that proves a control was
load-bearing rather than decorative.

The same blindness runs one level up. Session-level facts the harness is supposed to steer by — how many
sessions ran at once, how much of a session was steering versus waiting, which tool decisions were denied —
are emitted by the agent as OpenTelemetry and this repository collects none of it. It is the only measurement
gap that cannot be closed by writing a check, because the data is produced outside every process this
repository controls.

## Proposed outcome

The gate appends one line per decision to a durable local ledger — timestamp, verdict, HEAD, which arm fired,
the reason — so "how long did this gate cost" and "what has it refused" become queries instead of guesses.

And an agent session in this repository can export its telemetry with no infrastructure to stand up: a
dependency-free OTLP sink that writes what it receives to a file, plus the exact environment recipe, so the
session-level indicators are collectable by anyone who opts in rather than merely described in a table.

## Affected users and systems

`scripts/hooks/pre-push-gate.mjs` (writes the decision ledger), a new `scripts/telemetry/`, `package.json`,
`.claude/rules/ci.md`, skill `ci`, and a new document under `docs/`.

## Constraints

- **The log may never wedge the session.** A hook that throws while recording is worse than one that records
  nothing: the decision itself must survive a failed write.
- **It records the gate's decisions, not every Bash call.** The hook is wired on the `Bash` matcher and exits
  early for anything that is not a push; logging before that point would produce a shell transcript, not an
  audit trail.
- The ledger is local (`.git/`), because it describes this checkout's operations rather than the project's
  history. Say so rather than implying it travels.
- The telemetry sink holds no dependencies and requires no daemon a person forgets to run — when it is not
  listening, exports are dropped, and that must be stated rather than discovered.

## Open questions

- Should the decision ledger be rotated? Not yet: a solo checkout makes a handful of decisions a day. It
  becomes a question when the first band reads it.
