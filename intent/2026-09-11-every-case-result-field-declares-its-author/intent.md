# Intent: every field on the producer's document declares who authors it, or the compiler refuses

Author: Claude (from `pnpm scan --next` over `contracts`, 2026-09-11). Status: draft

Design: none — one named gap with a mechanical repair whose only real question is a classification this intent
deliberately does not guess at. A design pass would restate the table below.

## Problem

`CaseResult` is parsed from two producer surfaces: a self-hosted runner's `submit_job_result`, and the
`__EVERDICT_RESULT__` sentinel printed by a container whose image a workspace supplies. `UntrustedCaseResultSchema`
deletes the fields the PLATFORM authors, listed in `PLATFORM_STAMPED_RESULT_FIELDS`.

That list is a declaration, and **nothing re-asks it**. `pnpm untrusted-ingress` — the scanner built for this
exact class after three P0s (arch-reviews 66, 121, 122) — checks that a DOOR uses the untrusted schema. It
does not check that the schema strips the right fields. So a field added to `CaseResult` after the lesson
never learns it, and the failure is silent for as long as nobody asks.

It happened. `sourceTraceId` — "the platform trace this result was scored FROM", written only by the control
plane's own pulls (`collect-trace.ts`, the topology backend's `fetchDetailed`) — was absent from the list, so
a producer could name any trace id. The platform stored it as canonical and four external observability sinks
exported it verbatim as the route back from a verdict to the evidence it judged. It sat **two fields below**
the arch-review 122 comment that states this law in so many words. Found by `pnpm scan`, over a scope nobody
had touched, six days after the last scan — not by a gate, because no gate asks this.

The instance is repaired. The class is not.

## Proposed outcome

Every field on `CaseResult` is classified `platform` or `producer` in one exhaustive map, checked by the
COMPILER (`satisfies Record<keyof CaseResult, …>`, the shape `ACTIVITY_AXIS_BY_KIND` already uses for platform
event kinds). `PLATFORM_STAMPED_RESULT_FIELDS` is derived from it rather than maintained beside it, so adding
a field to the schema without saying who writes it does not build.

A compile error, not a scanner: the question is total over a known key set, which is exactly what the type
system answers for free and what a scanner would answer fragilely.

## Affected users and systems

`packages/contracts/src/execution/eval-case.ts` (the map and the derived list) and its counterexamples. No
runtime behaviour changes for any field whose classification is unchanged — which is the risk below.

## Constraints

- **A misclassification is worse than the gap.** A platform field marked `producer` reads as reviewed and
  ships the defect with a certificate. Each entry cites the evidence for its side: the field's own
  declaration, and its writers.
- **This is not a field sweep.** `traceSealed` is deliberately kept — its own comment says the distinction
  exists "unless the PRODUCER says so", which makes it a vouch and not a stamp. `traceRef` is written by
  `run-case.ts`, which runs IN the job, so it is the producer's correlation key. Stripping either would
  destroy a real signal.
- **The counterexample asserts BOTH directions.** A stripped field and a kept field, because a predicate with
  only refusal cases has an unmeasured false-positive rate (skill `code-review`, pass 5).

## Open questions

- **Three of the nineteen fields could not be classified by reading alone**, and this intent does not guess:
  - `evidence` — "extracted from a pulled trace", and who pulls decides it
  - `recordingRef` — an object-store coordinate, which is the `artifact://` class arch-review 121 closed for
    two sibling fields; whether this one is minted by the platform or named by the producer was not settled
  - `execution` — "self-reported by the execution site", which reads producer, against a name that reads
    platform
  Settling these is the work, and each needs its writers traced the way `sourceTraceId`'s were.
- **Does the same hole exist on the other producer documents?** `UntrustedTraceEventSchema` has the same
  shape and the same history (arch-review 121/122). This intent looked only at `CaseResult`.
- **Is a derived list enough?** The compiler refuses an unclassified field. It cannot refuse a field
  classified WRONG, which is the failure that actually happened here in a different form.
