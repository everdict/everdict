// 라이브 e2e (SLICE 88, service-topology Phase 2): K8sTopologyRuntime 를 *실제 K8s 클러스터(kind)*에 대고 구동.
// 지금까지 토폴로지 빌더/런타임은 mock kubectl 로만 단위 테스트됐다. 여기선 실 kind 클러스터에 warm 토폴로지를
// 띄우고(Deployment+Service apply → rollout 대기 → port-forward 로 엔드포인트 발견) front-door 로 per-run 페이로드를
// 실제로 전송한다. = "K8sTopologyRuntime apply against a real K8s cluster"(플랜 Phase 2)의 핵심 오케스트레이션 검증.
//
// 사전: 스텁 front-door 이미지(assay-topo-stub:demo, scripts/live/topology-stub/)를 kind 로드. 컨텍스트 kind-assay.
//   docker build -t assay-topo-stub:demo scripts/live/topology-stub
//   kind load docker-image assay-topo-stub:demo --name assay
// 풀 per-case 브라우저(CDP)+채점은 실 browser-use 이미지/agent-server 가 필요(Phase 2+) — 여기선 토폴로지 구동까지.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-assay";
const NS = "assay-default"; // K8sTopologyRuntime 의 nsFor(undefined) = namespacePrefix("assay-") + "default"
const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });

// 최소 service-topology 하니스(browser-use 형태의 축소판): 스텁 front-door 1개 + 브라우저 타깃.
const spec = {
  kind: "service",
  id: "topo-demo",
  version: "1.0.0",
  services: [{ name: "agent", image: "assay-topo-stub:demo", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [], // PG/Redis/MinIO 없이 — 순수 오케스트레이션 검증
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["screenshot"] },
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

const rt = new K8sTopologyRuntime({ context: CONTEXT, imagePullPolicy: "IfNotPresent", readyTimeoutMs: 120000 });
let ok = false;
try {
  console.log(`=== ensureTopology on real kind cluster (context=${CONTEXT}) ===`);
  const topo = await rt.ensureTopology(spec);
  const base = topo.endpoints.agent;
  console.log("discovered front-door endpoint:", base);

  // 실 클러스터에 Deployment 가 떴는지 직접 확인(증거).
  const deploys = k(["get", "deploy", "-n", NS, "-o", "name"]).trim();
  console.log("k8s deployments in ns:", deploys || "(none)");
  const ready = k([
    "get",
    "deploy",
    "topo-demo-agent",
    "-n",
    NS,
    "-o",
    "jsonpath={.status.readyReplicas}/{.status.replicas}",
  ]);
  console.log("topo-demo-agent ready:", ready);

  // front-door readiness + per-run drive(POST submit).
  const health = await fetch(`${base}/health`);
  console.log("GET /health →", health.status);
  const drive = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "topology phase2 demo", thread_id: "t1", stream_channel: "s1" }),
  });
  console.log("POST /runs (front-door submit) →", drive.status);

  // === per-case 브라우저(실 headless Chromium) provision + CDP 연결 + 스냅샷 ===
  console.log("\n=== provisionBrowserEnv (real chromedp/headless-shell on kind) ===");
  const runId = "topo-demo-run1";
  const browser = await rt.provisionBrowserEnv(spec, runId);
  console.log("browser CDP url:", browser.wiring.target_cdp_url); // 실 Chromium 의 webSocketDebuggerUrl
  const browserDeploy = k(["get", "deploy", "-n", NS, "-o", "name"]).trim();
  console.log("k8s deployments now:", browserDeploy.replace(/\n/g, " "));
  const snap = await browser.snapshot(); // CDP /json/list → url/dom
  console.log("snapshot.kind:", snap.kind, "url:", snap.url, "dom(targets):", String(snap.dom).slice(0, 80));
  const cdpLive = browser.wiring.target_cdp_url.startsWith("ws://") && snap.kind === "browser";
  await browser.dispose(); // per-case 브라우저만 제거(warm 유지)

  ok =
    health.status === 200 &&
    drive.status === 200 &&
    deploys.includes("topo-demo-agent") &&
    ready.startsWith("1") &&
    cdpLive;
  console.log(
    ok
      ? "\n✅ SLICE 89: service-topology 풀 per-case 경로를 실 kind 에서 — warm 토폴로지(Deployment+Service) 배포·발견·front-door 구동 + per-case 브라우저(실 headless Chromium 파드)를 띄워 CDP(webSocketDebuggerUrl) 연결·스냅샷(/json/list)·정리. 오케스트레이터-비종속 런타임의 라이브 구동(에이전트-server/extension drive 만 제외 = 실 browser-use 이미지 필요)."
      : "\n⚠️ 기대와 불일치",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  // teardown: port-forward 중지 + 네임스페이스 삭제(warm 토폴로지 정리).
  await rt.teardown(spec).catch(() => {});
  console.log("teardown done (forwards stopped, ns deleted)");
}
process.exit(ok ? 0 : 1);
