// live e2e (SLICE 91): MlflowTraceSource verified against a *real MLflow 3.x* (infra-mlflow :5501, basic auth).
// Symmetric to OTel/Jaeger (SLICE 90) — exercises the MLflow pull path (scorecard pull-ingest / service harness trace extraction) against a real backend.
// Log one trace via the python mlflow SDK (gen_ai tokens/model/cost as mlflow.* attributes) → pull it with MlflowTraceSource.fetch and
// verify it maps to a normalized TraceEvent (llm_call). Credentials (admin/PW) are read only from infra/.env and never committed/printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const ENDPOINT = process.env.MLFLOW_URL ?? "http://localhost:5501";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mlflowPassword() {
  if (process.env.MLFLOW_PW) return process.env.MLFLOW_PW;
  try {
    const t = readFileSync(new URL("../../../../infra/.env", import.meta.url), "utf8");
    return (t.match(/^MLFLOW_AUTH_ADMIN_PASSWORD=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const pw = mlflowPassword();
if (!pw) {
  console.error("No MLflow password (MLFLOW_PW or infra/.env).");
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`admin:${pw}`).toString("base64")}`;

// 1) Log one trace via the python mlflow SDK → trace_id.
const PY = `
import os, mlflow
mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
mlflow.set_experiment("everdict-trace-live")
with mlflow.start_span(name="chat") as s:
    s.set_inputs({"prompt": "hi"}); s.set_outputs({"reply": "hello"})
    s.set_attribute("mlflow.llm.model", "gpt-5.4-mini")
    s.set_attribute("mlflow.chat.tokenUsage", {"input_tokens": 100, "output_tokens": 42})
    s.set_attribute("mlflow.llm.cost", {"total_cost": 0.0012})
print("TRACE_ID=" + (mlflow.get_last_active_trace_id() or ""))
`;
console.log("=== MLflow trace logging (python mlflow SDK) ===");
const out = execFileSync("python3", ["-c", PY], {
  encoding: "utf8",
  env: {
    ...process.env,
    MLFLOW_TRACKING_URI: ENDPOINT,
    MLFLOW_TRACKING_USERNAME: "admin",
    MLFLOW_TRACKING_PASSWORD: pw,
  },
});
const tid = (out.match(/TRACE_ID=(\S+)/) || [])[1];
console.log("trace_id:", tid);

// 2) MlflowTraceSource.fetch → normalize.
console.log("\n=== MlflowTraceSource.fetch(trace_id) — real MLflow REST → normalize ===");
const src = new MlflowTraceSource({ endpoint: ENDPOINT, headers: { authorization: auth } });
let events = [];
for (let i = 0; i < 15 && events.length === 0; i++) {
  await sleep(1000);
  try {
    events = await src.fetch(tid);
  } catch {
    events = [];
  }
}
console.log("TraceEvent[]:", JSON.stringify(events));
const llm = events.find((e) => e.kind === "llm_call");
const ok =
  !!tid &&
  !!llm &&
  llm.model === "gpt-5.4-mini" &&
  llm.cost?.inputTokens === 100 &&
  llm.cost?.outputTokens === 42 &&
  Math.abs((llm.cost?.usd ?? 0) - 0.0012) < 1e-9;
console.log(
  ok
    ? "\n✅ SLICE 91: MlflowTraceSource pulls a trace logged in real MLflow 3.x and maps it to a normalized TraceEvent (llm_call: model=gpt-5.4-mini, in=100/out=42 tokens, usd=0.0012). Symmetric to OTel/Jaeger — both trace backends live-verified."
    : "\n⚠️ mismatch with expected (mapping/ingest)",
);
process.exit(ok ? 0 : 1);
