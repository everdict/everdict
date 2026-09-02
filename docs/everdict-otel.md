---
kind: wiki
title: "everdict-otel — sending traces to everdict (migration recipes)"
status: current
updated: 2026-07-31
---
# everdict-otel — sending traces to everdict (migration recipes)

Everdict ingests **standard OTLP/HTTP JSON** at `POST {control-plane}/v1/traces` (the N0 door — see
`docs/architecture/native-observability.md`). There is no everdict SDK to adopt: if your stack already
speaks OpenTelemetry — the OTel SDKs, Langfuse/LangSmith SDKs in OTLP mode, most agent frameworks —
pointing it at everdict is **configuration, not code**. `@everdict/otel` (`packages/otel`) is a tiny,
dependency-free TS helper for assembling that configuration; Python users need only the env vars below.

Two things make a trace land correctly:

1. **The door**: `OTEL_EXPORTER_OTLP_ENDPOINT` = your control plane, with a tenant API key (`ak_…`) as a
   Bearer header. Protocol `http/json`.
2. **The correlation**: the resource attribute `everdict.run_id` — spans without one are refused
   *visibly* (OTLP `partialSuccess`), never dropped silently. Each **emitter** seals **once**: the first
   export from a given emitter wins, a re-export is visibly rejected (evidence is never rewritten).
3. **The plane** (only for a system of several processes): the standard resource attribute
   `service.name`. The door groups a run's spans by it, so each service becomes its OWN plane of that
   run's trajectory — see below.

## Zero-code (any OTel-instrumented process, any language)

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://everdict.example.com"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ak_your_tenant_key"
export OTEL_RESOURCE_ATTRIBUTES="everdict.run_id=run-2026-07-30-001,everdict.kind=agent"
```

That is the whole Python story too — no everdict package required.

## A SYSTEM, not one process — every service on one trajectory

An eval rarely exercises a lone agent. The agent runs somewhere (an orchestrator places it) and drives
services (an API, a retriever, a browser worker). All three belong to ONE run, so everdict reads them as
one trajectory made of **planes**:

| Plane | Who produces it | How it arrives |
|---|---|---|
| agent | the harness under test | its own trace, sealed when the run settles |
| placement | the orchestrator (Nomad/K8s/self-hosted runner/sandbox) | appended by the backend — nothing to configure |
| `service:<name>` | each service you instrument | its OTLP spans through the door |

To put a service on that picture, give it the **same run correlation** and **its own `service.name`** —
OTel's own attribute, not an everdict one:

```bash
# in EVERY service of the system under test
export OTEL_SERVICE_NAME="checkout"          # this service's plane
export OTEL_RESOURCE_ATTRIBUTES="everdict.run_id=$EVERDICT_RUN_ID"
# (+ the same endpoint/headers as above)
```

Everdict runs inject `everdict.run_id` into the case environment, so a service usually only has to
forward it (env, or W3C `traceparent`/`baggage` propagation from the agent's request).

What you get: the run's detail page and Settings › Traces lay every plane on ONE time axis (each plane's
first span is its anchor), so "the agent waited 4s here" and "checkout was restarting there" are read
together instead of in two tools. Rules worth knowing:

- **A second service is not a duplicate.** Planes seal independently, so a service can arrive *before*
  the agent's own trace and neither loses. Only a re-export from the *same* emitter is rejected.
- **The agent's record stays the judged one.** Scores are computed over the execution's own plane — a
  service's spans enrich the picture, they never become "what the agent did".
- **Span duration survives.** A structural span carries its own length, so a service plane draws as
  bars, not as instants.
- **Unnamed spans stay with the run.** A process that sets no `service.name` lands in the run's own
  plane rather than inventing a service.

## TypeScript (in-code SDK config)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { everdictExporterOptions, everdictResourceAttributes } from "@everdict/otel";

const sdk = new NodeSDK({
  resource: resourceFromAttributes(everdictResourceAttributes({ runId: "run-2026-07-30-001", kind: "agent" })),
  traceExporter: new OTLPTraceExporter(
    everdictExporterOptions({ endpoint: "https://everdict.example.com", apiKey: process.env.EVERDICT_API_KEY ?? "" }),
  ),
});
sdk.start();
```

`everdictExporterEnv(...)` produces the same thing as env-var strings (for spawned processes), and
`everdictResourceAttributesEnv(...)` renders `OTEL_RESOURCE_ATTRIBUTES`.

## Python (env-only recipe)

```python
# pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http — then just env vars (above), or in code:
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"everdict.run_id": "run-2026-07-30-001"}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="https://everdict.example.com/v1/traces",
    headers={"Authorization": "Bearer ak_your_tenant_key"},
)))
```

> Note: the door speaks OTLP/HTTP **JSON** today; the stock Python exporter sends protobuf. Until the
> door grows protobuf (a later rung), Python users should front it with an OTel Collector (protobuf in →
> `otlphttp` JSON out) or use env-configured SDKs that support `http/json`.

## Migrating from Langfuse / LangSmith SDKs

Both SDKs can emit OTLP. Keep your instrumentation; swap the destination:

- **Langfuse (OTel mode)** / **LangSmith (`LANGSMITH_OTEL_ENABLED`)**: set the four env vars from the
  zero-code recipe. Your existing platform can stay as a SECOND destination — mirroring outward is
  first-class (register it under Settings › Traces and pick it per harness as a sink).

## What everdict does with it

Spans are normalized by the same `gen_ai.*`-aware pipeline the pull sources use, sealed in the owned
TrajectoryStore (`source: "otlp"`), browsable under Settings › Traces, served by
`GET /runs/:id/trajectory`, judged on demand (`POST /scorecards/ingest/pull` with
`source: {name: "everdict"}`) or on a clock (a pull-mode schedule over the `everdict` source), and
watched by tenant thresholds (`trace.threshold_crossed` wakes subscribed agents). See
`docs/scorecards.md` and `docs/api.md`.

## Semantic conventions

| Attribute | Meaning |
|---|---|
| `everdict.run_id` | REQUIRED — the run this trace belongs to (grouping + correlation key) |
| `everdict.kind` | executable family (`eval` \| `agent` \| `command` \| `sandbox` \| `analysis`) |
| `everdict.case_id` | the eval case, when applicable |
| `everdict.group_id` | the orchestration group (scorecard / conversation) |
| `gen_ai.*` | standard GenAI conventions — model, `gen_ai.usage.input_tokens` / `output_tokens` / `cost` |
| `service.name` | OTel's OWN attribute (not an everdict key) — the run's **plane** this process seals into |

The vocabulary is exported as `EVERDICT_SEMCONV` from `@everdict/otel` (user-facing, dependency-free)
and `@everdict/trace` (the receiver) — a drift-guard test keeps them in lockstep.
