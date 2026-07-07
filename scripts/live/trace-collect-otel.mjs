// 라이브 e2e: OTel 태그 상관(correlate="tag")을 *실제 Jaeger* 에 대고 검증 —
// docs/architecture/streaming-case-pipeline.md D4. 이 스크립트는 mlflow/phoenix e2e 와 달리 시드가 없다:
// **커맨드(계측 에이전트)가 직접** 자기 mint 한 OTLP trace id 로 스팬을 export 하고, 리소스 속성
// assay.run_id=$ASSAY_RUN_ID 만 남긴다 — assay 는 runId 를 어디에도 미리 알려주지 않고(runCase 가 mint)
// 태그 검색만으로 상관한다. 즉 "실 계측 에이전트 + 주입 env" 계약의 완전한 왕복.
//   O1 collect="job":           해제 후 collectTrace(runId) 가 Jaeger 검색(service+tags)으로 pull.
//   O2 collect="control-plane": traceRef{correlate:"tag", service} → executeCase 가 검색 pull + 미뤄진 채점.
// 준비: docker (jaegertracing/all-in-one 을 스크립트가 부팅/정리). 기존 서버는 JAEGER_QUERY/OTLP_URL.
// 사용: node scripts/live/trace-collect-otel.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeCase } from "../../apps/api/dist/execute-case.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { CommandHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";
import { buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "assay-trace-collect-otel";
const SERVICE = "instrumented-cli";
let bootedDocker = false;
let QUERY = process.env.JAEGER_QUERY ?? "";
let OTLP = process.env.OTLP_URL ?? "";

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

if (!QUERY) {
  QUERY = "http://127.0.0.1:16688";
  OTLP = "http://127.0.0.1:14319";
  console.log(`Jaeger 부팅(docker, all-in-one) → query ${QUERY} / OTLP ${OTLP}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "14319:4318",
    "-p",
    "16688:16686",
    "jaegertracing/all-in-one:1.62.0",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(`${QUERY}/api/services`)); i++) await sleep(1000);
if (!(await up(`${QUERY}/api/services`))) throw new Error(`Jaeger 가 뜨지 않음: ${QUERY}`);
console.log(`Jaeger up: ${QUERY}`);

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

// 계측 에이전트 역할의 스크립트 — 자기 mint 한 trace id 로 OTLP export, 상관은 리소스 속성으로만.
// (실 에이전트가 OTEL_RESOURCE_ATTRIBUTES=assay.run_id=… 를 반영하는 것과 동일한 계약을 셸로 재현.)
const EMIT_SH = `set -e
TID=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')
SID=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
SID2=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')
NOW=$(date +%s)000000000
cat > payload.json <<JSON
{"resourceSpans":[{"resource":{"attributes":[
 {"key":"service.name","value":{"stringValue":"${SERVICE}"}},
 {"key":"assay.run_id","value":{"stringValue":"$ASSAY_RUN_ID"}}]},
 "scopeSpans":[{"scope":{"name":"e2e"},"spans":[
 {"traceId":"$TID","spanId":"$SID","name":"chat","kind":1,
  "startTimeUnixNano":"$NOW","endTimeUnixNano":"$NOW",
  "attributes":[{"key":"gen_ai.request.model","value":{"stringValue":"gpt-5.4-mini"}},
  {"key":"gen_ai.usage.input_tokens","value":{"intValue":"42"}},
  {"key":"gen_ai.usage.output_tokens","value":{"intValue":"7"}}]},
 {"traceId":"$TID","spanId":"$SID2","name":"bash","kind":1,
  "startTimeUnixNano":"$NOW","endTimeUnixNano":"$NOW",
  "attributes":[{"key":"tool.name","value":{"stringValue":"bash"}},
  {"key":"tool.call_id","value":{"stringValue":"c1"}}]}]}]}]}
JSON
curl -sf -X POST -H 'content-type: application/json' --data @payload.json "$OTLP_BASE/v1/traces" > /dev/null
echo "run_id=$ASSAY_RUN_ID" > marker.txt
`;

try {
  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh emit.sh",
    env: { OTLP_BASE: OTLP }, // 에이전트의 export 대상(리터럴 env — 실 스펙과 동일 통로)
    params: {},
    trace: { kind: "otel", endpoint: QUERY, collect, correlate: "tag", service: SERVICE },
  });
  const graderSpecs = [{ id: "tests-pass", config: { cmd: "test -f marker.txt" } }, { id: "steps" }, { id: "cost" }];
  const caseFor = (id) => ({
    id,
    env: { kind: "repo", source: { files: { "emit.sh": EMIT_SH } } },
    task: "export a trace, leave a marker",
    graders: graderSpecs,
    timeoutSec: 120,
    tags: [],
  });
  // runCtx.runId 를 주지 않는다 — runCase 가 mint 한 키가 env 로 흘러가 태그가 되고, 그 태그로만 찾는다.
  const depsFor = (collect) => ({
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new CommandHarness(specFor(collect)),
    graders: makeGraders(graderSpecs),
    runCtx: { apiKeyEnv: {}, timeoutSec: 120 },
  });
  const score = (r, id) => r.scores.find((s) => s.graderId === id);

  // 1) O1 — collect="job": 해제 후 Jaeger 태그 검색 pull(재시도가 인제스트 지연 흡수).
  console.log("\n=== O1: collect=job — 에이전트 export → 태그 검색 in-job 수집 ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job"));
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(llm1?.model === "gpt-5.4-mini", "O1 태그 검색으로 실 Jaeger 스팬 수집(trace id 는 에이전트만 안다)");
  assert(score(r1, "tests-pass")?.pass === true, "O1 ground-truth PASS");
  assert((score(r1, "steps")?.value ?? 0) > 0, "O1 steps 도출");
  assert(r1.traceRef === undefined, "O1 traceRef 없음(잡 수집)");

  // 2) O2 — collect="control-plane": traceRef(correlate/service) → executeCase 가 검색 pull 로 완성.
  console.log("\n=== O2: collect=control-plane — traceRef(tag/service) → 잡 밖 수집 완성 ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane"));
  assert(
    pre.traceRef?.kind === "otel" && pre.traceRef?.correlate === "tag" && pre.traceRef?.service === SERVICE,
    "O2 traceRef 에 kind/correlate/service 동봉",
  );
  assert(pre.snapshot.diff.includes(`run_id=${pre.traceRef?.runId}`), "O2 에이전트가 본 키 = traceRef.runId");
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  assert(done.trace.find((e) => e.kind === "llm_call")?.model === "gpt-5.4-mini", "O2 실 Jaeger 검색 pull 로 완성");
  assert((score(done, "steps")?.value ?? 0) > 0, "O2 미뤄진 steps 채점");
  assert(score(done, "tests-pass")?.pass === true, "O2 ground-truth 보존");

  console.log(
    "\n✅ trace-collect otel live e2e PASS — 실 Jaeger 상대로 태그 상관 완전 왕복(에이전트-mint trace id, assay 는 assay.run_id 리소스 속성으로만 상관).",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker 정리 완료)");
    } catch {}
  }
}
