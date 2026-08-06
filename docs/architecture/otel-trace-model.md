# The trace model — spans are the record (OTel-compatible)

> **Status: DESIGN (maintainer decision, 2026-08-04).** Amends
> [native-observability.md](./native-observability.md), whose foothold table still reads
> "`TraceEvent` vocabulary … **unchanged** — the internal contract". That line was right for N0–N5 and is
> wrong now: it left us with two models for one thing, and the seam between them loses information at our
> own front door. The direction of native-observability (OTel as the ingestion standard, Everdict owns the
> collector and the store) is unchanged — this makes the *record* match it.

## The defect, stated once

We hold **two** models of a trace:

| | shape | who uses it |
|---|---|---|
| `Span` / `TraceSpanNode` | OTel-ish — `spanId`, `parentId`, start, end, attributes | platform pulls, the inspect waterfall |
| `TraceEvent` | a `kind` union with a scalar `t` | the ledger, judges, graders |

Everything that arrives as spans is **flattened** into events (`spansToTraceEvents`) and everything the
viewer draws is **un-flattened** back into nodes (`trajectorySpans`). Two conversions of the same
information in opposite directions, with a lossy hop in the middle. It happens even at our OWN OTel door:
`POST /v1/traces` parses real OTLP spans and then calls `spansToTraceEvents` before sealing
(`otlp-ingest-service.ts`). A tenant sends us a tree; we store a list; the UI guesses a tree back.

Three consequences, all observed in live data:

1. **Infra can only be points.** A self-hosted run's placement plane is `leased` (t=0) and `finished`
   (t=23262) — two instants. It is one 23.26-second interval with phases inside it. `kind:"infra"` is a
   sibling of `message`/`tool_call` in a union whose members are all instants, so an interval is
   inexpressible. The `durationMs` we bolted onto `STRUCTURE` is the span layer smuggled into the event layer.
2. **The internal agent reconstructs instead of recording.** `transcriptToTrace` projects a finished turn
   from persisted transcript rows, so an LLM call's own latency is never recorded (only turn-level usage),
   and retries, model fallbacks, compaction and subagents leave no trace at all — even though
   `agent-runtime`'s kernel already emits every one of them live through `onEvent`.
3. **We cannot export what we hold.** Our spans have no trace id, no span kind, no status, no span events,
   no resource/scope separation, and their ids are arbitrary strings (`tu_7`, `search-3`) rather than hex.
   So "egress = collector fan-out" (native-observability N4) is not reachable from the current record.

## What OTel actually says (the part we were missing)

OTel's trace model is **two layers**, and we only ever had the lower one:

- **Span** — an *interval*: `trace_id` · `span_id` · `parent_span_id` · `name` · `kind` · start/end ·
  `attributes` · `status` · `events[]` · `links[]`, under a `Resource` (who emitted) and an
  `InstrumentationScope` (what instrumented it).
- **Span Event** — a *point in time inside a span*: a name, a timestamp, attributes.

Our `TraceEvent` union is, almost exactly, the span-event layer. The fix is not to replace it — it is to
**restore the layer above it** and let each thing sit where it belongs. A tool call is a span; "Driver
Failure" is a span event on the placement span; an assistant message is a span event on the turn.

## The model

**`TraceSpan` (contracts) is the record.** OTLP-shaped, so it round-trips: hex `traceId`/`spanId`,
`parentSpanId`, `kind`, `status`, absolute `startedAt`/`endedAt`, `attributes`, `events[]`, `links[]`,
`resource`, `scope`.

**`TraceEvent[]` survives as a read-time PROJECTION.** Graders and judges read a handful of `kind ===`
filters (`trace-graders`, `assess-evidence`, `model-judge`, `browser-graders`); nothing about the scoring
contract moves. `spansToEvents` in `@everdict/domain` is that projection, and it is **versioned** (below).

### Attributes: the standard first, `everdict.*` only for what has none

Span names follow the GenAI convention — `chat {model}`, `execute_tool {tool}`, `invoke_agent {agent}`.

| our field | attribute |
|---|---|
| `llm_call.model` | `gen_ai.request.model` / `gen_ai.response.model` |
| `llm_call.cost.inputTokens` / `.outputTokens` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` |
| `llm_call.latencyMs` | the span's own start/end |
| `tool_call.name` / `.id` | `gen_ai.tool.name` / `gen_ai.tool.call.id` |
| `message.role` / `.text` | `gen_ai.input.messages` / `gen_ai.output.messages` (opt-in content) |
| `error.message` | `error.type` + span `status = error` |
| the session a turn belongs to | `gen_ai.conversation.id` |
| the provider | `gen_ai.provider.name` |
| **`llm_call.cost.usd`** | **`everdict.cost.usd` — no standard key exists** |

That last row is the honest exception: the GenAI conventions define tokens and stop there, leaving price to
the platform (Langfuse computes it too). Cost is load-bearing for our graders, so it keeps our prefix.

**The GenAI conventions are still `development`** and have already moved once (message content migrated
from span events to attributes). Every span we mint therefore records the convention version it was written
against, and the volatile half (content capture) is written under both the standard key and ours until the
convention settles. A vocabulary that churns upstream must not silently re-interpret sealed evidence.

### Infra is an extension of the vocabulary, not a second vocabulary

`kind:"infra"` stops being a union member and becomes **a span with attributes** — and most of those
attributes already exist in OTel:

```
resource:     service.name = everdict-job
              k8s.node.name | host.name          ← the node (was everdict-specific)
              k8s.pod.name  | container.id       ← the unit (was everdict-specific)
span:         kind   = client                     ← we are calling the orchestrator
              name   = "placement nomad"
              status = ok | error
              everdict.plane = placement          ← no standard key: ours
              everdict.nomad.alloc_id             ← no standard key: ours
span events:  "queued" · "leased" · "Driver Failure" · "OOMKilled"
```

The waterfall stays one waterfall; infra is a subtree in it. The extension happens in the *vocabulary*
layer only — which is what "same format, extended" has to mean if it is to mean anything.

### One trace id, because the causality is real

The job runs **inside** the placed unit, so the agent's spans are genuinely children of the placement span.
W3C `traceparent` propagates across the process boundary (control plane → job → harness) beside the
`EVERDICT_RUN_ID` and `OTEL_RESOURCE_ATTRIBUTES` we already inject — native-observability listed this as an
N5 remainder. Consequences:

- The **planes stop being a storage concept**. Segments-per-emitter stay as the write partition
  (first-write-wins per emitter is unchanged), but a "lane" becomes a group-by over `service.name` /
  `everdict.plane` at read time — which is already what `partitionSpansByService` does.
- A trace that leaves through an exporter is a *valid OTLP trace*, not a projection of one.

### Judge reproducibility: pin the projection, not the bytes

Spans are immutable once ended, so the record is stable; the projection is code, and code changes. Storing
the projected events beside the spans would double the ledger and re-introduce the drift we are removing.
Instead a scorecard records the **projection version** it judged under (`spansToEvents` carries one), so any
verdict can be re-derived exactly. The bytes stay singular; the interpretation is dated.

## The viewer stays on ONE path

A tempting corollary of "spans are the record" is that the waterfall should read spans directly. It should
not, and the reason is the defect itself: the projection now fills `spanId`/`parentId`/`durationMs`/`at` on
every event it emits, so the viewer's existing event→node projection already draws the exact tree the record
holds. Adding a spans-native renderer beside it would re-create the two-paths-for-one-thing shape N6 exists to
remove — and the two would drift, because only one of them would be exercised by old bodies.

What the wire does carry is the segment's `format`, so a reader can say *this is the record* rather than
inferring it. The events look identical either way; that is the point.

## Migration

**Sealed evidence is never rewritten** — the invariant predates this design and survives it. The ledger
gains an explicit body format; already-sealed `TraceEvent[]` bodies keep reading as events forever, new
writes are spans, and the read path projects. There is no backfill and no shape-sniffing: a row says what it
holds.

The AGENT does not go through assembly at all — it records. `TurnSpanRecorder` (`apps/agent/src/turn-spans.ts`)
listens to the kernel's existing `onEvent` stream and opens/closes spans as the loop works, so the evidence
finally carries what the transcript could never hold: the model call's own latency, a retry waiting out an
upstream failure, a fallback to a second model, a compaction that dropped half the context, and a subagent as
real nested work. Those spans travel to the control plane on the agent report beside the transcript
projection, which stays as the fallback for a turn with no run to hang under. Observed spans carry no
`everdict.assembled` marker — that distinction is the point of having one.

The recorder also carries the CONTENT of the exchange, because the kernel's event stream carries it (this
was closed as a defect: a first cut recorded intervals with empty hands). Per model call, the kernel emits a
`usage` event — `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` land on the `chat` span they
describe, not only as a turn aggregate on the root. A `tool_result` event carries a capped slice of what the
tool answered (`everdict.output` on the tool span). The member's message rides the root span
(`gen_ai.input.messages` + the dual `everdict.input`), the assistant's answer rides the chat span
(`gen_ai.output.messages` + `everdict.output`). And a chat span whose turn answered ONLY in tool calls is
closed at the first tool call / next turn instead of being overwritten — overwriting silently dropped most
model calls of an agentic turn.

Projection **v2** (`SPANS_TO_EVENTS_VERSION = 2`) makes that content readable on the event side:
an `invoke_agent` span projects as a structural `span` (its attribute bag stays visible) plus its recorded
input as a `message` — never as an `llm_call`, so the root's aggregate tokens cannot be double-counted next
to the per-call chat spans (records sealed before per-call usage existed keep their aggregate as the one
`llm_call` there is); and a chat span's captured output text projects as the assistant `message` a judge's
`kind === "message"` filter reads, beside the `llm_call` that carries its tokens.

Harnesses keep yielding `TraceEvent` from `run()`. That is deliberate, not a leftover: a harness is a
**black box over a process boundary**, a CLI reports points as they happen, and the live playground needs
those points before any span could close. `eventsToSpans` (domain) assembles them — a `tool_call` and its
`tool_result` share an id and become one span, an `llm_call` becomes its own, messages/logs/errors become
span events on the enclosing turn. Emitters that genuinely KNOW their spans — the agent runtime, the
dispatcher — build them directly and skip the assembly.

## One projection, not two

`spansToTraceEvents` (`@everdict/trace`) was a second implementation of the same attribute-dialect mapping —
one over the pull adapters' flat intermediate, one over `TraceSpan`. It is now a **promotion plus a
delegation**: the adapter's `Span` becomes a real `TraceSpan` (ids derived, so a platform's `chain-0` still
resolves its own parentage after the rewrite to hex) and `spansToEvents` does the mapping. One rule, one
place. The per-platform PARSERS stay where they are — reading MLflow's snake_case OTLP or Jaeger's
microseconds is genuinely per-platform work; only the projection was duplicated.

## Costs (honest)

- **The blast radius is wide** — `TraceEvent` is named in 267 non-test files. Most of them only pass it
  through; the ones that move are the ledger, the door, and the emitters.
- **Two body formats forever.** Dual-read is not a transition state, it is the price of never rewriting
  evidence. It must be explicit (a column), or it rots into sniffing.
- **A churning upstream vocabulary.** Pinning the semconv version is real bookkeeping, and the content-capture
  double-write is duplication we accept until the convention stabilizes.
- **Span assembly for black-box harnesses is inference.** It is honest inference (ids pair calls with
  results), but a CLI that reports nothing still yields a thin tree. The fix is upstream instrumentation,
  not cleverer assembly.

## Non-goals

- General APM. Scope stays AI-execution observability (native-observability's own scope discipline).
- Replacing the harness contract. `run()` stays an `AsyncIterable<TraceEvent>`.
- Moving scores into spans. Verdicts remain platform-layer records referencing trace ids — unchanged from
  native-observability §3, and the reason a mirror can be lossy while the record cannot.
