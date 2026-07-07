// Live e2e (SLICE 92, service-topology Phase 2): run NomadTopologyRuntime against *real Nomad* (local dev agent).
// Symmetric to K8sTopologyRuntime (SLICE 88/89) — live verification that the orchestrator-agnostic runtime also deploys a warm
// topology on Nomad (register the job → wait for alloc running → discover the dynamic host:port), sends a per-run payload to the
// front-door, and brings up a per-case browser (real headless Chromium) to connect CDP + snapshot.
//
// Prereq: start nomad agent -dev (docker driver); build the stub front-door image on the host.
//   nomad agent -dev & ; docker build -t everdict-topo-stub:demo scripts/live/topology-stub
import process from "node:process";
import { NomadTopologyRuntime } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://localhost:4646";

const spec = {
  kind: "service",
  id: "topo-demo",
  version: "1.0.0",
  services: [{ name: "agent", image: "everdict-topo-stub:demo", port: 8080, needs: [], perRun: [], replicas: 1 }],
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
      ? "\n✅ SLICE 92: the service-topology runtime deploys/drives a warm topology on real Nomad (dev) (register the job, alloc running, discover the dynamic host:port; front-door per-run send) + brings up a per-case browser (real headless Chromium) to connect CDP + snapshot. Symmetric to K8s — the orchestrator-agnostic runtime runs live on both orchestrators."
      : "\n⚠️ Mismatch vs expected",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  await rt.teardown(spec).catch(() => {});
  console.log("teardown done (jobs deregistered)");
}
process.exit(ok ? 0 : 1);
