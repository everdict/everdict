# Intent: a producer's span attribute mints a platform-plane record

Author: pnpm scan (scope `domain`, sonnet, 78c483f3) — verified by hand before filing. Status: draft

## Problem

`spansToEvents` reads a span's attributes to decide its *plane*, and when the plane is `placement` it emits a
`kind: "infra"` event — a record the PLATFORM authors, describing where a run was placed, with `unit` and
`node` taken from the same attribute bag (`packages/domain/src/trace/spans-to-events.ts:251`).

That is fine for spans the platform produced. It is not fine for the pull path.

`packages/trace/src/sources/trace-source.ts:317` converts spans fetched from a tenant's own observability
platform, and forwards the adapter's bag verbatim — the comment says so plainly: *"keeping the merge here is
honest about what we actually received."* It is honest, and it is the whole problem: what we received came
from whatever wrote spans to that platform, which for `POST /scorecards/ingest/pull` includes the harness
under test. Line 338 hands the result straight to `spansToEvents`.

Nothing in between strips it. `stripPlatformAuthoredFields`, the preprocessing behind every untrusted door,
removes **artifact refs and size fields** — `PLATFORM_AUTHORED_REF_FIELDS` and `PLATFORM_AUTHORED_SIZE_FIELDS`
— and never touches span *attributes*. `pnpm untrusted-ingress` cannot see this either: it checks which SCHEMA
a door parses with, and here the schema is right while the danger lives in an attribute VALUE the schema
faithfully preserves.

This is the fourth instance of the authorship law in this repository's history, and the first where the field
is not a field. The three before it were `CaseResult`'s GC coordinate, `outputRef`/`screenshotRef`, and
`provenance` — all closed by splitting a schema. Splitting a schema does not close this one.

## Proposed outcome

Attributes arriving from a producer cannot decide a platform-authored projection. The plane of a pulled span
is whatever the platform says it is — and for a pulled trace the platform said nothing, so the honest answer
is that there is no placement plane in it.

## Affected users and systems

`packages/domain/src/trace/spans-to-events.ts` (the projection), `packages/trace/src/sources/trace-source.ts`
(the pull path), and every reader of `kind: "infra"` — the judges that see a trace, the trajectory metrics that
count llm_calls and cost, and the trajectory store.

## Constraints

- The projection is shared: the same function serves spans the platform wrote and spans a tenant's platform
  returned. A fix that makes it refuse `everdict.*` outright would break the first caller.
- `spansToEvents` lives in `@everdict/domain` and must stay pure. Whatever distinguishes the two callers is an
  argument, not an ambient flag.
- What has NOT been verified by hand: the downstream damage the scan describes — that reclassifying real
  `llm_call` spans as `infra` zeroes cost and tool-count metrics while ground-truth checks still pass. The
  shape is plausible from `trajectoryMetrics` reading the same event stream, and it was not traced.

## Open questions

- Are there other attribute-derived decisions in this projection with the same property — a value a producer
  can set that selects a platform-authored record shape?
- Should `pnpm untrusted-ingress` grow a second question, or is "an attribute that selects a projection" a
  different check? The first three instances were schema choices at doors; this one is not, and a check that
  tries to be both may be neither.
