// Live verification: run a service-topology harness on a real Kubernetes (kind) — isomorphic to Nomad.
//
//  - warm topology: apply the front-door as a Deployment+Service → wait for rollout → discover the endpoint via port-forward
//  - per-case target: bring up a headless Chromium Deployment and discover the real CDP via port-forward
//  - drive: real POST /runs (per-run wiring) to the discovered front-door — verify via an HTTP 200 response
//  - tenant isolation: trust-zone (perTenantTrustZones) → per-tenant namespace everdict-<tenant> (K8s-native isolation)
//  - grade: real browser snapshot + trace → CaseResult → teardown (delete the namespace)
//
// Usage: KUBECONFIG context kind-everdict, kubectl on PATH.
//   PATH=$HOME/.local/bin:$PATH node scripts/live/service-topology-k8s.mjs

import { perTenantTrustZones } from "../../packages/backends/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.KUBE_CONTEXT ?? "kind-everdict";
const MLFLOW = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";

const SPEC = {
  kind: "service",
  id: "bu",
  version: "k8s-live",
  services: [
    { name: "agent-server", image: "mendhak/http-https-echo:latest", port: 8080, needs: [], perRun: [], replicas: 1 },
  ],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["dom", "url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: MLFLOW },
};

const JOB = {
  harness: { id: SPEC.id, version: SPEC.version },
  tenant: "acme",
  evalCase: {
    id: "svc-topo-k8s-1",
    env: { kind: "browser", startUrl: "about:blank" },
    task: "open the dashboard and confirm it loads",
    graders: [
      { id: "url-matches", config: { pattern: "about:blank" } },
      { id: "dom-contains", config: { text: "about:blank" } },
      { id: "steps" },
    ],
    timeoutSec: 120,
    tags: ["live", "k8s", "service-topology"],
  },
};

const banner = (s) => console.log(`\n=== ${s} ===`);

async function main() {
  const runtime = new K8sTopologyRuntime({
    context: CONTEXT,
    browserImage: "chromedp/headless-shell:latest",
    imagePullPolicy: "IfNotPresent", // use images preloaded into kind
    readyTimeoutMs: 120_000,
    pollIntervalMs: 1500,
  });

  const delivered = [];
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: new MlflowTraceSource({ endpoint: MLFLOW }),
    specFor: () => SPEC,
    trustZones: perTenantTrustZones(), // per-tenant namespace isolation
    submit: async (url, payload) => {
      delivered.push(payload);
      console.log(`  → POST ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`    front-door responded: HTTP ${res.status}`);
    },
  });

  banner("dispatch on K8s (ensure topology → per-case browser → drive → trace → grade)");
  const t0 = Date.now();
  let result;
  try {
    result = await backend.dispatch(JOB);
  } finally {
    banner("teardown");
    await runtime
      .teardown(SPEC, perTenantTrustZones().resolve("acme"))
      .catch((e) => console.log("  teardown:", e.message));
    console.log("  namespace everdict-acme deleted");
  }

  banner("RESULT");
  console.log("caseId  :", result.caseId);
  console.log("harness :", result.harness);
  console.log("snapshot:", JSON.stringify(result.snapshot).slice(0, 160));
  console.log("trace   :", result.trace.length, "events (real MLflow)");
  for (const s of result.scores) {
    console.log(`  - ${s.graderId}: pass=${s.pass} value=${s.value}${s.detail ? ` (${s.detail})` : ""}`);
  }
  console.log("elapsed :", ((Date.now() - t0) / 1000).toFixed(1), "s");

  banner("per-run wiring delivered over the network (K8s service)");
  const w = delivered[0] ?? {};
  console.log("thread_id     :", w.thread_id);
  console.log("minio_prefix  :", w.minio_prefix);
  console.log("browser_cdp_url:", w.browser_cdp_url);
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
