// 라이브 e2e: command trace kind 확장(phoenix)을 *실제 Arize Phoenix* 에 대고 검증 —
// docs/architecture/streaming-case-pipeline.md D4. mlflow e2e(trace-collect-mlflow.mjs)와 동일 패턴:
//   P1 collect="job":           runCase 가 compute 해제 후 collectTrace(runId) 로 실 Phoenix 에서 pull
//                               (buildTraceSource 팩토리 경유 — kind 확장의 실 배선 검증).
//   P2 collect="control-plane": 잡은 traceRef{kind:"phoenix", project} 만 → executeCase 가 실 pull + 미뤄진 채점.
//
// 상관: Phoenix 는 trace id 가 클라이언트 mint(OTLP hex) — 시드(PhoenixTraceSink)가 만든 trace id 를
// runId 로 주입(pull-ingest 관례). 시드 = "계측된 에이전트가 적재한 트레이스" 역할(싱크 경로는 기 검증).
// 준비: docker (arizephoenix/phoenix:latest 를 스크립트가 부팅/정리). 기존 서버는 PHOENIX_ENDPOINT.
// 사용: node scripts/live/trace-collect-phoenix.mjs
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
const CONTAINER = "everdict-trace-collect-phoenix";
const PROJECT = "everdict-collect-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.PHOENIX_ENDPOINT ?? "";

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:6116";
  console.log(`Phoenix 부팅(docker, arizephoenix/phoenix:latest) → ${ENDPOINT}`);
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "6116:6006", "arizephoenix/phoenix:latest"]);
  bootedDocker = true;
}
for (let i = 0; i < 90 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`Phoenix 가 뜨지 않음: ${ENDPOINT}`);
console.log(`Phoenix up: ${ENDPOINT}`);

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

try {
  // 1) 시드 — 싱크(create)로 스팬 적재 → 클라이언트-mint trace id 2건(P1/P2 용).
  const sink = buildTraceSink({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
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
  ];
  const seeded = await sink.export({ scorecardId: "sc-e2e", dataset: "d@1", harness: "h@1" }, [
    { caseId: "seed-job", trace: seedTrace, scores: [] },
    { caseId: "seed-cp", trace: seedTrace, scores: [] },
  ]);
  for (const c of seeded.cases) if (c.error) throw new Error(`시드 실패(${c.caseId}): ${c.error}`);
  const [tidJob, tidCp] = seeded.cases.map((c) => c.externalId);
  console.log(`seeded traces: job=${tidJob} cp=${tidCp}`);
  const source = buildTraceSource({ kind: "phoenix", endpoint: ENDPOINT, project: PROJECT });
  let seedEvents = [];
  for (let i = 0; i < 20 && seedEvents.length === 0; i++) {
    await sleep(1000);
    seedEvents = await source.fetch(tidJob).catch(() => []);
  }
  assert(
    seedEvents.some((e) => e.kind === "llm_call"),
    `시드 스팬 왕복 준비(${seedEvents.length}개 이벤트)`,
  );

  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh -c 'echo \"run_id=$EVERDICT_RUN_ID\" > marker.txt'",
    env: {},
    params: {},
    trace: { kind: "phoenix", endpoint: ENDPOINT, project: PROJECT, collect },
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

  // 2) P1 — collect="job": 해제 후 buildTraceSource(phoenix) 경유 in-job pull 왕복.
  console.log("\n=== P1: collect=job — 해제 후 in-job pull(팩토리 5종 배선) ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job", tidJob));
  assert(r1.snapshot.diff.includes(`run_id=${tidJob}`), "P1 상관 키 왕복(EVERDICT_RUN_ID)");
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(llm1?.model === "gpt-5.4-mini", "P1 실 Phoenix 스팬이 trace 로 수집됨");
  assert((score(r1, "steps")?.value ?? 0) > 0, "P1 steps 도출");
  assert(r1.traceRef === undefined, "P1 traceRef 없음(잡 수집)");

  // 3) P2 — collect="control-plane": traceRef 에 project 동봉 → executeCase 완성.
  console.log("\n=== P2: collect=control-plane — traceRef(project) → 잡 밖 수집 완성 ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane", tidCp));
  assert(
    pre.traceRef?.kind === "phoenix" && pre.traceRef?.project === PROJECT && pre.traceRef?.runId === tidCp,
    "P2 traceRef 에 kind/project/runId 동봉",
  );
  assert(pre.scores.map((s) => s.graderId).join(",") === "tests-pass", "P2 잡은 ground-truth 만 채점");
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  assert(done.trace.find((e) => e.kind === "llm_call")?.model === "gpt-5.4-mini", "P2 실 Phoenix pull 로 trace 완성");
  assert((score(done, "steps")?.value ?? 0) > 0, "P2 미뤄진 steps 채점");
  assert(score(done, "tests-pass")?.pass === true, "P2 ground-truth 보존(이중 채점 없음)");

  console.log(
    "\n✅ trace-collect phoenix live e2e PASS — command trace kind 확장이 실 Phoenix 상대로 D4 양 모드에서 동작.",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker 정리 완료)");
    } catch {}
  }
}
