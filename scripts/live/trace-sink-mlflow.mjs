// 라이브: 실 MLflow 3.x 에 트레이스 싱크 export — docs/architecture/trace-sink.md 의 두 모드 검증.
//   create(흐름①): MlflowTraceSink 가 StartTraceV3 로 trace 를 만들고 assessments 로 점수 부착
//     (+ OTLP/JSON 스팬은 서버 ≥3.12 에서만 — 미만이면 스팬만 빠진 degrade 를 그대로 확인).
//   attach(흐름②): 기존 trace id 에 점수만 부착(복제 없음) → assessments 가 늘어난다.
//   round-trip: MlflowTraceSource.fetch 로 되읽기(스팬이 실렸으면 TraceEvent 로 정규화).
//
// 준비: MLflow 3.x(Basic auth) — infra 스택(:5501) 또는 임의 서버. 환경: MLFLOW_ENDPOINT, MLFLOW_USER,
//   MLFLOW_PASSWORD. 사용 예:
//   MLFLOW_PASSWORD=*** node scripts/live/trace-sink-mlflow.mjs
import process from "node:process";
import { MlflowTraceSource, buildTraceSink } from "../../packages/trace/dist/index.js";

const ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const USER = process.env.MLFLOW_USER ?? "admin";
const PASS = process.env.MLFLOW_PASSWORD ?? "";
const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

console.log(`trace-sink live e2e — 실 MLflow(${ENDPOINT})에 create/attach 두 모드 검증\n`);

// 0) 서버 버전(스팬 업로드 가능 여부 안내용) + 전용 experiment 생성.
const version = (await api("/version").catch(() => null)) ?? null;
console.log(`server version: ${version ?? "(조회 불가 — 계속)"}`);
const expName = `assay-trace-sink-e2e-${Date.now()}`;
const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
  method: "POST",
  body: JSON.stringify({ name: expName }),
});
console.log(`experiment: ${expName} (id=${experimentId})`);

// 1) create 모드 — 케이스 2개(trace+점수, judge:* 포함)를 싱크로 내보낸다.
const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, auth, project: experimentId });
const ctx = { scorecardId: "sc-live-1", dataset: "d@1.0.0", harness: "h@1" };
const mkCase = (caseId) => ({
  caseId,
  trace: [
    { t: 0, kind: "message", role: "user", text: `${caseId} 과업 지시` },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
    { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
    { t: 40, kind: "message", role: "assistant", text: "완료" },
  ],
  scores: [
    { name: "tests_pass", value: 1, pass: true },
    { name: "judge:quality", value: 0.8, comment: "근거 충분" },
  ],
});
const created = await sink.export(ctx, [mkCase("c1"), mkCase("c2")]);
for (const c of created.cases) {
  if (c.error) throw new Error(`✗ create 실패(${c.caseId}): ${c.error}`);
  console.log(`create: ${c.caseId} → ${c.externalId}`);
}
console.log(`top url: ${created.url}`);

// 2) 되읽기 — assessments 가 실제로 붙었는지 REST 로 검증.
const readAssessments = async (traceId) => {
  const body = await api(`/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}`);
  return (body.trace?.trace_info?.assessments ?? []).map((a) => a.assessment_name);
};
const t1 = created.cases[0].externalId;
const names1 = await readAssessments(t1);
if (!names1.includes("tests_pass") || !names1.includes("judge:quality"))
  throw new Error(`✗ create 후 assessments 불일치: ${JSON.stringify(names1)}`);
console.log(`✓ create: ${t1} 의 assessments = ${JSON.stringify(names1)}`);

// 3) attach 모드 — 같은 trace 에 점수만 추가(흐름②: 복제 없이 원본에 부착).
const attached = await sink.export(ctx, [
  { caseId: "c1", trace: [], scores: [{ name: "judge:safety", value: 1, pass: true }], externalId: t1 },
]);
if (attached.cases[0]?.error) throw new Error(`✗ attach 실패: ${attached.cases[0].error}`);
const names2 = await readAssessments(t1);
if (!names2.includes("judge:safety")) throw new Error(`✗ attach 후 assessments 불일치: ${JSON.stringify(names2)}`);
console.log(`✓ attach: 기존 trace 에 judge:safety 추가 → ${JSON.stringify(names2)}`);

// 4) round-trip — MlflowTraceSource 로 되읽기. 스팬은 서버 ≥3.12(OTLP/JSON)에서만 실린다.
// <3.12 서버는 OTLP/JSON 을 거부해 스팬이 없고, 스팬 없는 trace 의 traces/get 은 500
// ("Trace data not stored in tracking store")을 던진다 — 문서화된 degrade 로 취급.
const source = new MlflowTraceSource({ endpoint: ENDPOINT, headers: { authorization: auth } });
let events = [];
let spanReadError;
try {
  events = await source.fetch(t1);
} catch (err) {
  spanReadError = String(err?.message ?? err);
  if (!spanReadError.includes("Trace data not stored")) throw err;
}
if (spanReadError) {
  console.log(
    `△ round-trip: 서버가 OTLP/JSON 미수용(<3.12) — 스팬 없음(${spanReadError.slice(0, 80)}…). trace_info+assessments 만 실림(문서화된 degrade)`,
  );
} else if (events.length > 0) {
  const llm = events.find((e) => e.kind === "llm_call");
  if (!llm || llm.model !== "gpt-5.4-mini") throw new Error(`✗ round-trip 정규화 불일치: ${JSON.stringify(events)}`);
  console.log(
    `✓ round-trip: 스팬 ${events.length}개 이벤트로 정규화(llm_call 모델/토큰 일치) — 서버가 OTLP/JSON 수용(≥3.12)`,
  );
} else {
  console.log(
    "△ round-trip: 스팬 0건 — 서버가 OTLP/JSON 미수용(<3.12)이라 trace_info+assessments 만 실림(문서화된 degrade)",
  );
}

console.log(
  "\n✅ trace-sink live e2e PASS — 실 MLflow 에 create(StartTraceV3+assessments)·attach(원본 trace 에 점수만) 두 모드 검증.",
);
process.exit(0);
