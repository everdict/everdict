// 라이브 e2e (SLICE 91): MlflowTraceSource 를 *실제 MLflow 3.x*(infra-mlflow :5501, basic auth)에 대고 검증.
// OTel/Jaeger(SLICE 90)와 대칭 — MLflow 쪽 pull 경로(scorecard pull-ingest / service 하니스 trace 추출)를 실 backend 로.
// python mlflow SDK 로 trace 1건 로깅(gen_ai 토큰/모델/cost 를 mlflow.* 속성으로) → MlflowTraceSource.fetch 로 끌어와
// 정규화 TraceEvent(llm_call)로 매핑되는지 확인. 자격증명(admin/PW)은 infra/.env 에서만 읽고 절대 커밋/출력 안 함.
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
  console.error("MLflow 비밀번호 없음(MLFLOW_PW 또는 infra/.env).");
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`admin:${pw}`).toString("base64")}`;

// 1) python mlflow SDK 로 trace 1건 로깅 → trace_id.
const PY = `
import os, mlflow
mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
mlflow.set_experiment("assay-trace-live")
with mlflow.start_span(name="chat") as s:
    s.set_inputs({"prompt": "hi"}); s.set_outputs({"reply": "hello"})
    s.set_attribute("mlflow.llm.model", "gpt-5.4-mini")
    s.set_attribute("mlflow.chat.tokenUsage", {"input_tokens": 100, "output_tokens": 42})
    s.set_attribute("mlflow.llm.cost", {"total_cost": 0.0012})
print("TRACE_ID=" + (mlflow.get_last_active_trace_id() or ""))
`;
console.log("=== MLflow 트레이스 로깅(python mlflow SDK) ===");
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

// 2) MlflowTraceSource.fetch → 정규화.
console.log("\n=== MlflowTraceSource.fetch(trace_id) — 실 MLflow REST → 정규화 ===");
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
    ? "\n✅ SLICE 91: MlflowTraceSource 가 실제 MLflow 3.x 에서 로그된 trace 를 끌어와 정규화 TraceEvent(llm_call: model=gpt-5.4-mini, in=100/out=42 tokens, usd=0.0012)로 매핑. OTel/Jaeger 와 대칭 — 두 trace backend 모두 라이브 검증."
    : "\n⚠️ 기대와 불일치(매핑/인제스트)",
);
process.exit(ok ? 0 : 1);
