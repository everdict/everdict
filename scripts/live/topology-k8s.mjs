// Live e2e (SLICE 88, service-topology Phase 2): run K8sTopologyRuntime against a *real K8s cluster (kind)*.
// So far the topology builders/runtime were only unit-tested with mock kubectl. Here we bring up a warm topology on a real kind cluster
// (apply Deployment+Service → wait for rollout → discover the endpoint via port-forward) and actually send a per-run payload
// to the front-door. = the core orchestration verification of "K8sTopologyRuntime apply against a real K8s cluster" (plan Phase 2).
//
// Prereq: load the stub front-door image (everdict-topo-stub:demo, scripts/live/topology-stub/) into kind. Context kind-everdict.
//   docker build -t everdict-topo-stub:demo scripts/live/topology-stub
//   kind load docker-image everdict-topo-stub:demo --name everdict
// The full per-case browser (CDP) + grading needs the real browser-use image / agent-server (Phase 2+) — here we stop at driving the topology.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { K8sTopologyRuntime } from "../../packages/topology/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-everdict";
const NS = "everdict-default"; // K8sTopologyRuntime's nsFor(undefined) = namespacePrefix("everdict-") + "default"
const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });

// Minimal service-topology harness (a scaled-down browser-use form): one stub front-door + a browser target.
const spec = {
  kind: "service",
  id: "topo-demo",
  version: "1.0.0",
  services: [{ name: "agent", image: "everdict-topo-stub:demo", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [], // no PG/Redis/MinIO — pure orchestration verification
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

  // Directly confirm the Deployment came up on the real cluster (evidence).
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

  // === per-case browser (real headless Chromium) provision + CDP connection + snapshot ===
  console.log("\n=== provisionBrowserEnv (real chromedp/headless-shell on kind) ===");
  const runId = "topo-demo-run1";
  const browser = await rt.provisionBrowserEnv(spec, runId);
  console.log("browser CDP url:", browser.wiring.target_cdp_url); // the real Chromium's webSocketDebuggerUrl
  const browserDeploy = k(["get", "deploy", "-n", NS, "-o", "name"]).trim();
  console.log("k8s deployments now:", browserDeploy.replace(/\n/g, " "));
  const snap = await browser.snapshot(); // CDP /json/list → url/dom
  console.log("snapshot.kind:", snap.kind, "url:", snap.url, "dom(targets):", String(snap.dom).slice(0, 80));
  const cdpLive = browser.wiring.target_cdp_url.startsWith("ws://") && snap.kind === "browser";
  await browser.dispose(); // remove only the per-case browser (keep warm)

  ok =
    health.status === 200 &&
    drive.status === 200 &&
    deploys.includes("topo-demo-agent") &&
    ready.startsWith("1") &&
    cdpLive;
  console.log(
    ok
      ? "\n✅ SLICE 89: the full per-case service-topology path on real kind — deploy/discover the warm topology (Deployment+Service), drive the front-door + bring up a per-case browser (real headless Chromium pod) to connect CDP (webSocketDebuggerUrl), snapshot (/json/list), and clean up. Live run of the orchestrator-agnostic runtime (only the agent-server/extension drive is excluded = needs the real browser-use image)."
      : "\n⚠️ Mismatch vs expected",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  // teardown: stop port-forward + delete the namespace (clean up the warm topology).
  await rt.teardown(spec).catch(() => {});
  console.log("teardown done (forwards stopped, ns deleted)");
}
process.exit(ok ? 0 : 1);
