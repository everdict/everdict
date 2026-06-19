// 라이브: 실 MLflow 3.x 백엔드에서 트레이스 ingestion — browser-use Phase 2 의 "real MLflow span ingestion".
// emitter 가 실 MLflow(:5501)에 browser-use 모양 트레이스를 만들고, 우리 **MlflowTraceSource** 가 Basic auth 로
// 끌어와 정규화 TraceEvent[] 로 변환 → trace 기반 그레이더(steps/cost)로 채점. (stand-in 의 빈 트레이스 한계를 닫음.)
//   emit(real MLflow) → MlflowTraceSource.fetch(trace_id) → spansToTraceEvents → grade.
//
// 준비: MLflow 3.x(:5501, Basic auth) + mlflow-skinny venv. 환경: MLFLOW_ENDPOINT, MLFLOW_USER, MLFLOW_PASSWORD,
//   MLFLOW_PY(venv python). 사용 예:
//   MLFLOW_PASSWORD=*** MLFLOW_PY=/tmp/mlf-venv/bin/python node scripts/live/mlflow-trace-ingest.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { costGrader, stepsGrader } from "../../packages/graders/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const USER = process.env.MLFLOW_USER ?? "admin";
const PASS = process.env.MLFLOW_PASSWORD ?? "";
const PY = process.env.MLFLOW_PY ?? "python3";
const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

console.log("real MLflow span ingestion — emit → MlflowTraceSource → TraceEvent[] → grade\n");
// 1) 실 MLflow 에 트레이스 생성(emitter).
const out = execFileSync(PY, ["scripts/live/mlflow-emit-trace.py"], {
  encoding: "utf8",
  env: {
    ...process.env,
    MLFLOW_TRACKING_URI: ENDPOINT,
    MLFLOW_TRACKING_USERNAME: USER,
    MLFLOW_TRACKING_PASSWORD: PASS,
  },
});
const traceId = /TRACE_ID=(\S+)/.exec(out)?.[1];
if (!traceId) throw new Error(`emitter 에서 TRACE_ID 못 찾음:\n${out}`);
console.log("emitted trace_id:", traceId);

// 2) 우리 MlflowTraceSource 로 실 트레이스 ingest(Basic auth).
const source = new MlflowTraceSource({ endpoint: ENDPOINT, headers: { Authorization: auth } });
const trace = await source.fetch(traceId);
console.log("ingested TraceEvent[]:");
for (const e of trace) {
  if (e.kind === "llm_call")
    console.log(
      `  llm_call  model=${e.model} in=${e.cost?.inputTokens} out=${e.cost?.outputTokens} usd=${e.cost?.usd}`,
    );
  else if (e.kind === "tool_call") console.log(`  tool_call ${e.name} (#${e.id})`);
  else if (e.kind === "tool_result") console.log(`  tool_result ok=${e.ok}`);
  else if (e.kind === "message") console.log(`  message   ${String(e.text).slice(0, 50)}`);
  else console.log(`  ${e.kind}`);
}

// 3) 채점: 실 트레이스 위에서 steps/cost 그레이더.
const evalCase = {
  id: "mlflow-ingest-1",
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
  (llm.cost?.usd ?? 0) > 0 &&
  !!tool &&
  steps.value >= 1;
console.log(
  ok
    ? "\n✅ real MLflow span ingestion: MlflowTraceSource 가 실 MLflow 3.x 트레이스를 끌어와 llm_call(모델/토큰/비용)+tool_call 로 정규화하고 trace 그레이더로 채점. browser-use Phase 2 — 실 트레이스 인제스트 동작."
    : "\n⚠️ ingestion/매핑 불일치",
);
process.exit(ok ? 0 : 1);
