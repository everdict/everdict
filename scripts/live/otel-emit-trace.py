# Live e2e helper: use the real OTel SDK to export a browser-use-shaped trace (agent→LLM→tool, gen_ai conventions) over OTLP/HTTP
# to Jaeger and print the trace_id (32-hex). OtelTraceSource pulls it via the Jaeger query API and grades.
# Env: OTEL_EXPORTER_OTLP_ENDPOINT (default http://127.0.0.1:4318/v1/traces).
# Usage: <venv>/bin/python scripts/live/otel-emit-trace.py  (requires opentelemetry-sdk + exporter-otlp-proto-http)
import os
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318/v1/traces")
prov = TracerProvider(resource=Resource.create({"service.name": "browser-use-agent"}))
prov.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
trace.set_tracer_provider(prov)
tr = trace.get_tracer("everdict")

with tr.start_as_current_span("browser_agent_run") as root:
    tid = format(root.get_span_context().trace_id, "032x")
    with tr.start_as_current_span("chat gpt-5.4-mini") as s:  # OTel GenAI conventions
        s.set_attribute("gen_ai.request.model", "gpt-5.4-mini")
        s.set_attribute("gen_ai.response.model", "gpt-5.4-mini")
        s.set_attribute("gen_ai.usage.input_tokens", 42)
        s.set_attribute("gen_ai.usage.output_tokens", 7)
        s.set_attribute("gen_ai.usage.cost", 0.0012)
    with tr.start_as_current_span("browser.navigate") as t:
        t.set_attribute("tool.name", "browser.navigate")
        t.set_attribute("tool.call_id", "c1")
        t.set_attribute("tool.result", "ok")
prov.force_flush()
print("TRACE_ID=" + tid)
