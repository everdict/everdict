// 라이브: 실 Jaeger 에서 OTel trace ingestion — browser-use Phase 2 의 "real OTel/Jaeger span ingestion".
// emitter 가 OTel SDK 로 browser-use 모양 trace 를 Jaeger(OTLP)에 내보내고, 우리 **OtelTraceSource** 가 Jaeger
// query API(GET /api/traces/{id} → {data:[{spans}]})로 끌어와 정규화 TraceEvent[] 로 변환 → steps/cost 채점.
//   emit(OTLP→Jaeger) → OtelTraceSource.fetch(trace_id) → parseJaegerSpans → spansToTraceEvents → grade.
//
// 준비: Jaeger all-in-one(query :16686, OTLP :4318) + opentelemetry venv. 환경: JAEGER_ENDPOINT, OTEL_PY.
// 사용: OTEL_PY=/tmp/mlf-venv/bin/python node scripts/live/otel-trace-ingest.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { costGrader, stepsGrader } from "../../packages/graders/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const JAEGER = process.env.JAEGER_ENDPOINT ?? "http://127.0.0.1:16686";
const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces";
const PY = process.env.OTEL_PY ?? "python3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("real OTel/Jaeger span ingestion — emit(OTLP→Jaeger) → OtelTraceSource → TraceEvent[] → grade\n");
// 1) OTel SDK 로 Jaeger 에 trace 내보내기.
const out = execFileSync(PY, ["scripts/live/otel-emit-trace.py"], {
  encoding: "utf8",
  env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: OTLP },
});
const traceId = /TRACE_ID=(\S+)/.exec(out)?.[1];
if (!traceId) throw new Error(`emitter 에서 TRACE_ID 못 찾음:\n${out}`);
console.log("emitted trace_id:", traceId, "— Jaeger 인덱싱 대기 …");
await sleep(4000);

// 2) 우리 OtelTraceSource 로 Jaeger 에서 ingest(자동 Jaeger-형식 감지).
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

// 3) 채점: 실 trace 위에서 steps/cost.
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
    ? "\n✅ real OTel/Jaeger span ingestion: OtelTraceSource 가 실 Jaeger query 형식을 끌어와 llm_call(모델/토큰)+tool_call 로 정규화하고 채점. browser-use Phase 2 — OTel 인제스트 동작(MLflow 와 동형)."
    : "\n⚠️ ingestion/매핑 불일치",
);
process.exit(ok ? 0 : 1);
