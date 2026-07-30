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
   *visibly* (OTLP `partialSuccess`), never dropped silently. A run seals **once**: the first export for
   a run id wins, later batches are visibly rejected (rung-1 posture; live-append is a later rung).

## Zero-code (any OTel-instrumented process, any language)

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://everdict.example.com"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ak_your_tenant_key"
export OTEL_RESOURCE_ATTRIBUTES="everdict.run_id=run-2026-07-30-001,everdict.kind=agent"
```

That is the whole Python story too — no everdict package required.

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

The vocabulary is exported as `EVERDICT_SEMCONV` from `@everdict/otel` (user-facing, dependency-free)
and `@everdict/trace` (the receiver) — a drift-guard test keeps them in lockstep.
