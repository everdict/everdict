// Live: OTel trace ingestion from real Jaeger — browser-use Phase 2's "real OTel/Jaeger span ingestion".
// The emitter uses the OTel SDK to export a browser-use-shaped trace to Jaeger (OTLP), and our **OtelTraceSource** pulls it via the Jaeger
// query API (GET /api/traces/{id} → {data:[{spans}]}) and normalizes it to TraceEvent[] → steps/cost grading.
//   emit(OTLP→Jaeger) → OtelTraceSource.fetch(trace_id) → parseJaegerSpans → spansToTraceEvents → grade.
//
// Setup: Jaeger all-in-one (query :16686, OTLP :4318) + opentelemetry venv. Env: JAEGER_ENDPOINT, OTEL_PY.
// Usage: OTEL_PY=/tmp/mlf-venv/bin/python node scripts/live/otel-trace-ingest.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { costGrader, stepsGrader } from "../../packages/graders/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const JAEGER = process.env.JAEGER_ENDPOINT ?? "http://127.0.0.1:16686";
const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces";
const PY = process.env.OTEL_PY ?? "python3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("real OTel/Jaeger span ingestion — emit(OTLP→Jaeger) → OtelTraceSource → TraceEvent[] → grade\n");
// 1) Export a trace to Jaeger with the OTel SDK.
const out = execFileSync(PY, ["scripts/live/otel-emit-trace.py"], {
  encoding: "utf8",
  env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: OTLP },
});
const traceId = /TRACE_ID=(\S+)/.exec(out)?.[1];
if (!traceId) throw new Error(`no TRACE_ID found in emitter output:\n${out}`);
console.log("emitted trace_id:", traceId, "— waiting for Jaeger indexing …");
await sleep(4000);

// 2) Ingest from Jaeger with our OtelTraceSource (auto-detects the Jaeger format).
const source = new OtelTraceSource({ endpoint: JAEGER });
let trace = await source.fetch(traceId);
for (let i = 0; i < 6 && trace.length === 0; i++) {
  await sleep(2000);
  trace = await source.fetch(traceId);
}
console.log("ingested TraceEvent[]:");
for (const e of trace) {
  if (e.kind === "llm_call")
    console.log(
      `  llm_call  model=${e.model} in=${e.cost?.inputTokens} out=${e.cost?.outputTokens} usd=${e.cost?.usd}`,
    );
  else if (e.kind === "tool_call") console.log(`  tool_call ${e.name} (#${e.id})`);
  else if (e.kind === "tool_result") console.log(`  tool_result ok=${e.ok}`);
  else console.log(`  ${e.kind}`);
}

// 3) Grade: steps/cost over the real trace.
const evalCase = {
  id: "otel-ingest-1",
  env: { kind: "repo", source: { files: {} } },
  task: "browse",
  graders: [],
  timeoutSec: 60,
  tags: [],
};
const ctx = { case: evalCase, trace };
const steps = await stepsGrader.grade(ctx);
const cost = await costGrader.grade(ctx);
console.log(`\nsteps grader : value=${steps.value}`);
console.log(`cost grader  : value=${cost.value}`);

const llm = trace.find((e) => e.kind === "llm_call");
const tool = trace.find((e) => e.kind === "tool_call");
const ok =
  !!llm &&
  llm.kind === "llm_call" &&
  llm.model === "gpt-5.4-mini" &&
  llm.cost?.inputTokens === 42 &&
  llm.cost?.outputTokens === 7 &&
  !!tool &&
  steps.value >= 1;
console.log(
  ok
    ? "\n✅ real OTel/Jaeger span ingestion: OtelTraceSource pulls the real Jaeger query format, normalizes to llm_call (model/tokens) + tool_call, and grades. browser-use Phase 2 — OTel ingest works (isomorphic to MLflow)."
    : "\n⚠️ ingestion/mapping mismatch",
);
process.exit(ok ? 0 : 1);
