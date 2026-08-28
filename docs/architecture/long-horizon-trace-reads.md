# Long-horizon trace reads — the event is the unit

> **Status: R0 landed, R1–R3 in flight.** A long-horizon agent run is hundreds of turns over hours, and its
> trace carries what those turns produced: tool results holding file dumps, logs, span attributes copied
> verbatim from a tenant's OTel exporter. Reading one of those traces exhausted the control plane's heap.
> This document is why that happened, and the four changes that remove the cause rather than the symptom.

## The defect, stated once

**The storage and transport unit is the whole trajectory, not the event.** Everything else follows from that
one sentence, and no amount of tuning around it helps.

`PgTrajectoryStore.get` selects the `body` jsonb of the header row and of every segment, with no window and
no bound. `bodyOf` then runs `TraceEventSchema.array().parse(body)` — Zod's array parse builds a **complete
second copy** — and for a `spans` body it also runs `spansToEvents`, after which the segment holds `spans`
AND the projected `events`. The route then `JSON.stringify`s the whole thing into one string before writing
a byte. Peak residency for one request is several full copies of a body that is already the largest object
in the system.

    pg text buffer → JSON.parse object graph → Zod copy → spans→events projection → stringify output

The ClickHouse rung is not the escape hatch it looks like: `argMin(body, sealed_at)` aggregates the blob
column server-side, `res.text()` buffers the entire HTTP response as one string, and then it parses twice
like Postgres does. Same unit, one tier down.

**And the heap is shared.** The control plane is one process, so a single workspace opening one long-horizon
run ended every other workspace's in-flight request. This is the availability shape arch-review 72 closed
one level up — where a single legacy campaign row took down a workspace's campaign list — except the blast
radius here is the deployment.

Three reads paid the full cost for answers that did not need it:

| read | what it wanted | what it took |
|---|---|---|
| `RunService.withTrajectoryUsage` | five numbers for a cost badge | every plane's body, parsed twice |
| `ClickHouseTrajectoryStore.seal` | "has this emitter sealed already?" | every plane's body, to decide a set membership |
| `GET /trajectories/:id` | a page of a viewer | the whole trajectory, with no pagination parameter in the API |

## What must hold

1. **A read that needs a number does not take a body.** The writer derives what it already holds; the reader
   asks for the answer (rule `protocol` L3 — provenance is born at the source).
2. **An underivable summary is UNKNOWN, never zero** (L2). These are billing-adjacent numbers, and a
   manufactured zero is invented evidence in the one place a reader would not think to doubt it.
3. **One event is bounded, and so is one page.** Windowing bounds how MANY events a read materializes;
   payload offload bounds how large ONE event can be. Neither is sufficient alone: a window of a hundred
   events is only bounded if the events are.
4. **The bound is a property of the type, not of a caller's diligence.** A `get` that CAN return everything
   will, from some caller, eventually.
5. **Sealed evidence is never rewritten.** Every repair here is additive: legacy rows keep decoding, and what
   cannot be derived from them stays honestly absent (the `docs/migration/` expand → deploy → contract shape).

---

## R0 — the writer derives, the reader asks *(landed)*

`TrajectoryStore.usage(tenant, runId)` answers `TrajectoryUsage`:

    { kind: "derived"; usage: RunUsageSummary } | { kind: "absent" } | { kind: "unknown"; reason: … }

`sealBody` — the one function every store impl already routes through — derives the summary from the body it
is about to write, and mig 0199 gives both Postgres tables a `usage jsonb` column (the ClickHouse twin is a
`String`, `''` = not derived). `usage()` is answered by a statement that selects **emitters and summaries
only**; the test asserts the SQL text does not contain `body`, because a behavioral test cannot see a
regression that merely costs memory.

Which plane's economics it reports is resolved by `executionEmitterOf` over the emitter NAMES — the same
resolution `get` uses for `events`, extracted so the two cannot drift. A topology run whose services push
spans before the agent settles has a service as its header row; reporting the header's numbers would bill a
checkout service's LLM calls as the agent's.

`ClickHouseTrajectoryStore.seal` no longer calls `get`. A body-free `planes()` read answers both questions
it had — "has this emitter sealed?" and "does another workspace own this id?" — so the separate existence
probe is gone with the read that needed it.

**Legacy rows are not backfilled by the migration.** A SQL backfill would be `usageFromTrace` spelled a
second time, in another language, over evidence that is never rewritten — a predicate written twice has
already diverged. `scripts/live/backfill-trajectory-usage.mjs` repays them through the one derivation,
smallest row first, refusing any body over `--max-bytes` and **naming** the rows it skipped; those keep
answering `unknown`, which is true.

## R1 — the offload law applies to trace payloads *(in flight)*

`TraceEvent`'s `artifact` kind is already ref-only — `ref` is "a fetchable pointer, not the bytes". Nothing
else is. `tool_result.output`, `log.text` and `span.attributes` are unbounded, and `offloadSnapshot` covers
only an `EnvSnapshot`'s screenshot and DOM. So `DOM_INLINE_MAX = 8192` exists as a law with no counterpart
on the side where the bytes actually arrive.

The repair is that law made universal at the seal choke point (the `NamingTrajectoryStore` precedent — one
decorator, wrapped once at the composition root, so no seal path has to remember): an oversized event payload
is put to the `ArtifactStore` and replaced by an `artifact://` ref plus an inline preview, exactly as the DOM
is. This is what bounds ONE event, which windowing cannot.

## R2 — the event is the addressable unit *(in flight)*

`everdict_trajectory_events (run_id, emitter, seq, …)` on Postgres and its ClickHouse twin ordered by
`(tenant, run_id, emitter, seq)`. `get` takes a **required** window and returns a cursor in the house
pagination shape; there is deliberately no `getAll`, because an optional window is a request and a required
one is a protocol. Legacy blob rows project into the same window so they keep reading, and a blob row too
large to project answers a named refusal rather than an OOM — R0's ceiling stays as the floor for exactly
those rows.

## R3 — streaming for the consumers that genuinely need everything *(in flight)*

Judges, `spansToEvents`, the trace sinks and `usageFromTrace` legitimately read every event. They get an
`AsyncIterable<TraceEvent>` over the windows, so peak residency is a window rather than a trace — and the
Zod double-copy disappears with it, since each event is validated and then let go.

## Deliberately not

- **No cap on what a harness may emit.** Everdict retains what happened; truncating evidence at the door to
  protect the reader is the trade this document exists to avoid making.
- **No lossy compaction of sealed bodies.** Evidence is never rewritten (`docs/architecture/otel-trace-model.md`
  N6); offload moves bytes, it does not discard them.
- **No per-tenant heap accounting.** The fix is that no single read is unbounded, not that unbounded reads are
  fairly shared.

## Related

- `docs/architecture/otel-trace-model.md` — spans as the record, the versioned `spansToEvents` projection.
- `docs/architecture/native-observability.md` — the owned store, the OTLP door, ingestion quota + retention.
- Rule `protocol` — L2 (unknown is unignorable) and L3 (provenance at the source), which R0 is an application of.
- `packages/application-control/src/ports/artifact-store.ts` — `offloadSnapshot`, the law R1 generalizes.
