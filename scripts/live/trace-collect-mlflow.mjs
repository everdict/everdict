// 라이브 e2e: 2-페이즈 트레이스 수집(D4)을 *실제 MLflow 3.14*에 대고 검증 — docs/architecture/streaming-case-pipeline.md
//   S1 collect="job":          runCase 가 compute 해제 후 collectTrace(runId) 로 실 MLflow 에서 pull —
//                              같은 runId 가 커맨드 env(EVERDICT_RUN_ID)와 pull 양쪽에 흐르는 왕복을 확인.
//   S2 collect="control-plane": 잡(runCase)은 traceRef 만 들고 실행에서 끝 → executeCase 가 실 MLflow pull +
//                              미뤄진 관측물 채점(steps/cost)으로 결과를 완성.
//   S3 soft-degrade:           죽은 엔드포인트 → error 이벤트 가시화 + 잡의 ground-truth 점수 보존.
//
// 상관 참고: 실 MLflow 는 trace id 를 서버가 mint 하므로(everdict 가 지정 불가) runId = 플랫폼 trace id 로
// 주입한다(pull-ingest 의 runs[{caseId,runId}] 관례와 동일). "계측된 에이전트가 적재한 트레이스"는
// MlflowTraceSink(create+OTLP 스팬, ≥3.12)로 시드 — 싱크 e2e(trace-sink-mlflow.mjs)에서 이미 검증된 경로.
// 태그(everdict.run_id) 검색 상관은 설계 문서의 follow-up.
//
// 준비: docker (ghcr.io/mlflow/mlflow:v3.14.0 을 스크립트가 부팅/정리). 기존 서버를 쓰려면 MLFLOW_ENDPOINT.
// 사용: node scripts/live/trace-collect-mlflow.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeCase } from "../../apps/api/dist/execute-case.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { CommandHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-collect-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "";

async function up(url) {
  try {
    return (await fetch(`${url}/version`)).ok;
  } catch {
    return false;
  }
}

// 0) MLflow 준비 — MLFLOW_ENDPOINT 없으면 v3.14.0 을 docker 로 부팅(OTLP 스팬 업로드는 ≥3.12 필요).
if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:5507";
  console.log(`MLflow 부팅(docker, v3.14.0) → ${ENDPOINT}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "5507:5000",
    "ghcr.io/mlflow/mlflow:v3.14.0",
    "mlflow",
    "server",
    "--host",
    "0.0.0.0",
    "--port",
    "5000",
    "--backend-store-uri",
    "sqlite:////tmp/mlflow.db",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`MLflow 가 뜨지 않음: ${ENDPOINT}`);
console.log(`MLflow up: ${ENDPOINT} (version=${await (await fetch(`${ENDPOINT}/version`)).text()})`);

const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

try {
  // 1) 시드 — "계측된 에이전트가 플랫폼에 적재한 트레이스" 2건(S1/S2 용). 스팬에 llm/tool 이 실린다(≥3.12).
  const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name: `everdict-trace-collect-e2e-${Date.now()}` }),
  });
  const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, project: experimentId });
  const seedTrace = [
    { t: 0, kind: "message", role: "user", text: "과업 지시" },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
    { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
  ];
  const seeded = await sink.export({ scorecardId: "sc-e2e", dataset: "d@1", harness: "h@1" }, [
    { caseId: "seed-job", trace: seedTrace, scores: [] },
    { caseId: "seed-cp", trace: seedTrace, scores: [] },
    { caseId: "seed-tag", trace: seedTrace, scores: [] },
  ]);
  for (const c of seeded.cases) if (c.error) throw new Error(`시드 실패(${c.caseId}): ${c.error}`);
  const [tidJob, tidCp, tidTag] = seeded.cases.map((c) => c.externalId);
  console.log(`seeded traces: job=${tidJob} cp=${tidCp} tag=${tidTag}`);
  // 스팬이 읽힐 때까지 폴링(업로드 직후 지연 흡수).
  const source = buildTraceSource({ kind: "mlflow", endpoint: ENDPOINT });
  let seedEvents = [];
  for (let i = 0; i < 15 && seedEvents.length === 0; i++) {
    await sleep(1000);
    seedEvents = await source.fetch(tidJob).catch(() => []);
  }
  assert(
    seedEvents.some((e) => e.kind === "llm_call"),
    `시드 스팬 왕복 준비(llm_call ${seedEvents.length}개 이벤트)`,
  );

  // 공용 — 선언형 command 하니스(계측 CLI 흉내: 주입된 EVERDICT_RUN_ID 를 marker 로 남긴다) + 케이스.
  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh -c 'echo \"run_id=$EVERDICT_RUN_ID\" > marker.txt'",
    env: {},
    params: {},
    trace: { kind: "mlflow", endpoint: ENDPOINT, collect },
  });
  const graderSpecs = [{ id: "tests-pass", config: { cmd: "test -f marker.txt" } }, { id: "steps" }, { id: "cost" }];
  const caseFor = (id) => ({
    id,
    env: { kind: "repo", source: { files: { "README.md": "seed\n" } } },
    task: "leave a marker",
    graders: graderSpecs,
    timeoutSec: 120,
    tags: [],
  });
  const depsFor = (collect, runId) => ({
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new CommandHarness(specFor(collect)),
    graders: makeGraders(graderSpecs),
    runCtx: { apiKeyEnv: {}, timeoutSec: 120, runId },
  });
  const score = (r, id) => r.scores.find((s) => s.graderId === id);

  // 2) S1 — collect="job": 실행(마커) → compute 해제 → collectTrace(runId) 가 실 MLflow 에서 pull → 관측물 채점.
  console.log("\n=== S1: collect=job — 해제 후 in-job pull 왕복 ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job", tidJob));
  assert(
    r1.snapshot.diff.includes(`run_id=${tidJob}`),
    "S1 상관 키 왕복 — 커맨드가 본 EVERDICT_RUN_ID = pull 에 쓴 runId",
  );
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(
    llm1?.model === "gpt-5.4-mini" && llm1?.cost?.inputTokens === 42,
    "S1 실 MLflow 스팬이 trace 로 수집됨(llm_call 42/7)",
  );
  assert(score(r1, "tests-pass")?.pass === true, "S1 ground-truth(tests-pass) PASS");
  assert((score(r1, "steps")?.value ?? 0) > 0, "S1 steps 가 수집된 트레이스에서 도출됨");
  assert(Math.abs((score(r1, "cost")?.value ?? 0) - 0.01) < 1e-9, "S1 cost 가 수집된 llm_call 비용에서 도출됨(0.01)");
  assert(r1.traceRef === undefined, "S1 traceRef 없음(잡 수집 — 미룸 없음)");

  // 3) S2 — collect="control-plane": 잡은 traceRef 만 → executeCase 가 pull+미뤄진 관측물 채점으로 완성.
  console.log("\n=== S2: collect=control-plane — 잡 밖 수집으로 완성 ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane", tidCp));
  assert(
    pre.traceRef?.kind === "mlflow" && pre.traceRef?.runId === tidCp,
    "S2 잡 결과에 traceRef(kind/endpoint/runId)",
  );
  assert(!pre.trace.some((e) => e.kind === "llm_call"), "S2 잡 안 pull 없음(실행 이벤트만)");
  assert(
    pre.scores.map((s) => s.graderId).join(",") === "tests-pass",
    "S2 잡은 ground-truth 만 채점(관측물 채점 미룸)",
  );
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  const llm2 = done.trace.find((e) => e.kind === "llm_call");
  assert(llm2?.model === "gpt-5.4-mini", "S2 executeCase 가 실 MLflow 에서 pull 해 trace 완성");
  assert((score(done, "steps")?.value ?? 0) > 0, "S2 미뤄진 steps 가 컨트롤플레인에서 채점됨");
  assert(Math.abs((score(done, "cost")?.value ?? 0) - 0.01) < 1e-9, "S2 미뤄진 cost 채점(0.01)");
  assert(score(done, "tests-pass")?.pass === true, "S2 잡의 ground-truth 점수 보존(이중 채점 없음: tests-pass 1건)");
  assert(done.scores.filter((s) => s.graderId === "tests-pass").length === 1, "S2 tests-pass 정확히 1건");

  // 4) S3 — soft-degrade: 죽은 엔드포인트 → error 이벤트 가시화 + 실행 산출물 보존(케이스 안 죽음).
  console.log("\n=== S3: soft-degrade — 수집 실패는 실행 산출물을 버리지 않는다 ===");
  const broken = { ...pre, traceRef: { ...pre.traceRef, endpoint: "http://127.0.0.1:59999" } };
  const degraded = await executeCase({ dispatcher: { dispatch: async () => broken }, buildTraceSource }, "e2e", job);
  assert(
    degraded.trace.some((e) => e.kind === "error" && e.message.includes("트레이스 수집 실패")),
    "S3 수집 실패가 error 이벤트로 가시화",
  );
  assert(score(degraded, "tests-pass")?.pass === true, "S3 ground-truth 점수 보존(soft-degrade)");

  // 5) S4 — correlate="tag": 실 계측 에이전트 관례. 에이전트는 자기 trace 에 everdict.run_id 태그만 남기고
  //    (실 SDK 의 set_trace_tag = PATCH /traces/{id}/tags), everdict 는 자기가 mint 한 runId(트레이스 id 가
  //    아님!)로 태그 검색 상관 — runId=trace_id 관례 없이 실 MLflow 에서 수집이 도는지 검증.
  console.log("\n=== S4: correlate=tag — everdict.run_id 태그 검색 상관(잡 밖 수집) ===");
  const tagRunId = `everdict-e2e-${Date.now().toString(36)}`;
  await api(`/api/3.0/mlflow/traces/${tidTag}/tags`, {
    method: "PATCH",
    body: JSON.stringify({ key: "everdict.run_id", value: tagRunId }),
  });
  const specTag = {
    ...specFor("control-plane"),
    trace: {
      kind: "mlflow",
      endpoint: ENDPOINT,
      collect: "control-plane",
      correlate: "tag",
      experiment: String(experimentId),
    },
  };
  const preTag = await runCase(caseFor("c-tag"), {
    ...depsFor("control-plane", tagRunId),
    harness: new CommandHarness(specTag),
  });
  assert(
    preTag.traceRef?.correlate === "tag" && preTag.traceRef?.experiment === String(experimentId),
    "S4 traceRef 에 tag 상관 좌표(correlate/experiment) 동봉",
  );
  assert(
    preTag.snapshot.diff.includes(`run_id=${tagRunId}`),
    "S4 커맨드가 본 EVERDICT_RUN_ID = 태그 값(에이전트 계약)",
  );
  const jobTag = { evalCase: caseFor("c-tag"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const doneTag = await executeCase({ dispatcher: { dispatch: async () => preTag }, buildTraceSource }, "e2e", jobTag);
  const llmTag = doneTag.trace.find((e) => e.kind === "llm_call");
  assert(llmTag?.model === "gpt-5.4-mini", "S4 태그 검색으로 실 스팬 수집(runId ≠ trace_id 인데도 상관 성공)");
  assert((score(doneTag, "steps")?.value ?? 0) > 0, "S4 미뤄진 관측물 채점 완성");

  console.log(
    "\n✅ trace-collect live e2e PASS — 실 MLflow 3.14 상대로 D4 검증: 해제 후 in-job pull 왕복(S1) · 잡 밖 수집 완성(S2) · soft-degrade(S3) · everdict.run_id 태그 상관(S4).",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker 정리 완료)");
    } catch {}
  }
}
