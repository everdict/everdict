// Live: trace ingestion from a real MLflow 3.x backend — browser-use Phase 2's "real MLflow span ingestion".
// The emitter creates a browser-use-shaped trace in real MLflow (:5501), and our **MlflowTraceSource** pulls it
// with Basic auth and normalizes it to TraceEvent[] → grade with trace-based graders (steps/cost). (Closes the empty-trace limitation of the stand-in.)
//   emit(real MLflow) → MlflowTraceSource.fetch(trace_id) → spansToTraceEvents → grade.
//
// Setup: MLflow 3.x (:5501, Basic auth) + mlflow-skinny venv. Env: MLFLOW_ENDPOINT, MLFLOW_USER, MLFLOW_PASSWORD,
//   MLFLOW_PY (venv python). Example:
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
// 1) Create a trace in real MLflow (emitter).
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
if (!traceId) throw new Error(`no TRACE_ID found in emitter output:\n${out}`);
console.log("emitted trace_id:", traceId);

// 2) Ingest the real trace with our MlflowTraceSource (Basic auth).
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

// 3) Grade: steps/cost graders over the real trace.
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
    ? "\n✅ real MLflow span ingestion: MlflowTraceSource pulls a real MLflow 3.x trace, normalizes it to llm_call (model/tokens/cost) + tool_call, and grades with trace graders. browser-use Phase 2 — real trace ingest works."
    : "\n⚠️ ingestion/mapping mismatch",
);
process.exit(ok ? 0 : 1);
