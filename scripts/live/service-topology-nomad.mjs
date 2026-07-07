// 라이브 검증: service-topology 하니스를 실제 Nomad 클러스터에서 구동한다.
//
// 무엇이 "실제"인가:
//  - warm 토폴로지: front-door 서비스(stand-in)를 Nomad SERVICE 잡으로 배포 → alloc 에서 host:port 발견
//  - per-case 타깃 환경: headless Chromium 을 Nomad 에 띄우고 실 CDP 엔드포인트를 발견(/json/version)
//  - drive: 발견한 front-door 로 실제 네트워크 POST /runs (per-run wiring 주입) — alloc 로그로 검증
//  - trace: 실제 MLflow(REST)에서 trace 조회(인증/미존재 시 빈 트레이스로 degrade)
//  - grade: 실 브라우저 스냅샷 + trace 로 채점 → CaseResult → teardown
//
// 무엇이 stand-in 인가(실 이미지가 필요한 Phase 2):
//  - front-door = mendhak/http-https-echo (browser-use agent-server 대체; 요청을 stdout 에 로깅)
//  - 브라우저 클라이언트 익스텐션(--load-extension; 헤드풀) 미적용
//
// 사용: NOMAD_ADDR=http://127.0.0.1:4646 node scripts/live/service-topology-nomad.mjs

// 워크스페이스 패키지명은 scripts/ 에서 해석되지 않으므로 빌드된 dist 를 직접 import
// (각 패키지의 @everdict/* 의존성은 pnpm 심링크로 패키지 내부에서 해석된다).
import {
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  buildBrowserJob,
  buildNomadTopologyJob,
  keysFor,
} from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const MLFLOW_ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const FRONTDOOR_IMAGE = process.env.FRONTDOOR_IMAGE ?? "mendhak/http-https-echo:latest";
const BROWSER_IMAGE = process.env.BROWSER_IMAGE ?? "chromedp/headless-shell:latest";
// docker bridge gateway: alloc 컨테이너에서 호스트의 공유 스토어로 가는 경로(주입 시연용).
const HOST_GW = process.env.HOST_GW ?? "172.17.0.1";

/** @type {import("@everdict/core").ServiceHarnessSpec} */
const SPEC = {
  kind: "service",
  id: "browser-use-langgraph",
  version: "live-nomad",
  services: [
    {
      name: "agent-server",
      image: FRONTDOOR_IMAGE,
      port: 8080,
      needs: ["postgres", "redis", "browser-mcp"],
      perRun: ["thread_id", "stream_channel", "minio_prefix", "browser_cdp_url"],
      replicas: 1,
    },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", isolateBy: "key-prefix" },
    { store: "minio", role: "snapshots", isolateBy: "object-prefix" },
  ],
  target: {
    kind: "browser",
    engine: "chromium",
    lifecycle: "per-case-instance",
    observe: ["dom", "url"],
  },
  frontDoor: { service: "agent-server", submit: "POST /runs", trace: "GET /runs/{id}/events" },
  traceSource: { kind: "mlflow", endpoint: MLFLOW_ENDPOINT },
};

/** @type {import("@everdict/core").AgentJob} */
const JOB = {
  harness: { id: SPEC.id, version: SPEC.version },
  evalCase: {
    id: "svc-topo-live-1",
    env: { kind: "browser", startUrl: "about:blank" },
    task: "open the dashboard and confirm it loads",
    // 실 브라우저 스냅샷 + trace 로 채점 (url-matches/dom-contains = 브라우저, steps = trace).
    graders: [
      { id: "url-matches", config: { pattern: "about:blank" } },
      { id: "dom-contains", config: { text: "about:blank" } },
      { id: "steps" },
    ],
    timeoutSec: 120,
    tags: ["live", "nomad", "service-topology"],
  },
};

function banner(s) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  banner("rendered Nomad specs (what gets applied)");
  console.log(
    "topology job:",
    JSON.stringify(buildNomadTopologyJob(SPEC, { storeEnv: storeEnv() }).Job.TaskGroups[0].Networks),
  );
  console.log("browser job id:", buildBrowserJob(SPEC, "RUNID").Job.ID);

  const runtime = new NomadTopologyRuntime({
    addr: NOMAD_ADDR,
    browserImage: BROWSER_IMAGE,
    storeEnv: storeEnv(),
    pollIntervalMs: 1500,
    maxPolls: 120,
    readyTimeoutMs: 90_000,
  });

  // per-run wiring 이 front-door 에 실제로 도달했는지 검증하려고 submit 을 감싼다.
  const delivered = [];
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: new MlflowTraceSource({ endpoint: MLFLOW_ENDPOINT }),
    specFor: () => SPEC,
    submit: async (url, payload) => {
      delivered.push({ url, payload });
      console.log(`  → POST ${url}`);
      console.log(`    payload: ${JSON.stringify(payload)}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`    front-door responded: HTTP ${res.status}`);
    },
  });

  banner("dispatch (ensure topology → per-case browser → drive → trace → grade)");
  const started = Date.now();
  let result;
  try {
    result = await backend.dispatch(JOB);
  } finally {
    banner("teardown");
    await runtime.teardown(SPEC).catch((e) => console.log("  topology teardown:", e.message));
    console.log("  warm topology + per-case browser deregistered (purge=true)");
  }

  banner("RESULT");
  console.log("caseId  :", result.caseId);
  console.log("harness :", result.harness);
  console.log("snapshot:", JSON.stringify(result.snapshot));
  console.log("trace   :", result.trace.length, "events (from real MLflow)");
  console.log("scores  :");
  for (const s of result.scores) {
    console.log(`  - ${s.graderId}: pass=${s.pass} value=${s.value}${s.detail ? ` (${s.detail})` : ""}`);
  }
  console.log("elapsed :", ((Date.now() - started) / 1000).toFixed(1), "s");

  banner("per-run wiring delivered over the network");
  const wiring = delivered[0]?.payload ?? {};
  const expected = keysFor(wiring.thread_id?.replace(/^run-/, "") ?? "");
  console.log("thread_id     :", wiring.thread_id);
  console.log("stream_channel:", wiring.stream_channel);
  console.log("minio_prefix  :", wiring.minio_prefix);
  console.log("browser_cdp_url:", wiring.browser_cdp_url);
  console.log("derived-keys consistent:", wiring.minio_prefix === expected.minioPrefix);
}

function storeEnv() {
  return {
    PG_URL: `postgresql://everdict@${HOST_GW}:55433/everdict`,
    REDIS_URL: `redis://${HOST_GW}:6379`,
    MINIO_ENDPOINT: `http://${HOST_GW}:9100`,
  };
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
