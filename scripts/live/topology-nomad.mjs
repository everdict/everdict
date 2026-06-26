// 라이브 e2e (SLICE 92, service-topology Phase 2): NomadTopologyRuntime 를 *실제 Nomad*(로컬 dev agent)에 대고 구동.
// K8sTopologyRuntime(SLICE 88/89)와 대칭 — 오케스트레이터-비종속 런타임이 Nomad 위에서도 warm 토폴로지를 배포(잡 등록
// → alloc running 대기 → dynamic host:port 발견)하고 front-door 로 per-run 페이로드를 보내며, per-case 브라우저(실 headless
// Chromium)를 띄워 CDP 연결·스냅샷한다는 라이브 검증.
//
// 사전: nomad agent -dev (docker driver) 기동; 스텁 front-door 이미지 호스트 빌드.
//   nomad agent -dev & ; docker build -t assay-topo-stub:demo scripts/live/topology-stub
import process from "node:process";
import { NomadTopologyRuntime } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://localhost:4646";

const spec = {
  kind: "service",
  id: "topo-demo",
  version: "1.0.0",
  services: [{ name: "agent", image: "assay-topo-stub:demo", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["screenshot"] },
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

const rt = new NomadTopologyRuntime({
  addr: ADDR,
  browserImage: "chromedp/headless-shell:latest",
  readyTimeoutMs: 120000,
});
let ok = false;
try {
  console.log(`=== ensureTopology on real Nomad (addr=${ADDR}) ===`);
  const topo = await rt.ensureTopology(spec);
  const base = topo.endpoints.agent;
  console.log("discovered front-door endpoint:", base); // http://<hostIp>:<dynamicPort>

  const health = await fetch(`${base}/health`);
  console.log("GET /health →", health.status);
  const drive = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "topology phase2 nomad", thread_id: "t1", stream_channel: "s1" }),
  });
  console.log("POST /runs (front-door submit) →", drive.status);

  console.log("\n=== provisionBrowserEnv (real chromedp/headless-shell on Nomad) ===");
  const browser = await rt.provisionBrowserEnv(spec, "topo-demo-run1");
  console.log("browser CDP url:", browser.wiring.target_cdp_url);
  const snap = await browser.snapshot();
  console.log("snapshot.kind:", snap.kind, "url:", snap.url);
  const cdpLive = browser.wiring.target_cdp_url.startsWith("ws://") && snap.kind === "browser";
  await browser.dispose();

  ok = health.status === 200 && drive.status === 200 && cdpLive;
  console.log(
    ok
      ? "\n✅ SLICE 92: service-topology 런타임이 실제 Nomad(dev)에서 warm 토폴로지(잡 등록·alloc running·dynamic host:port 발견)를 배포·구동(front-door per-run 전송) + per-case 브라우저(실 headless Chromium)를 띄워 CDP 연결·스냅샷. K8s 와 대칭 — 오케스트레이터-비종속 런타임이 두 오케스트레이터에서 라이브 동작."
      : "\n⚠️ 기대와 불일치",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  await rt.teardown(spec).catch(() => {});
  console.log("teardown done (jobs deregistered)");
}
process.exit(ok ? 0 : 1);
