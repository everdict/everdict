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

import { caseOutcome, perTenantTrustZones } from "../../packages/domain/dist/index.js";
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
      // The header comment says "verify via an HTTP 200 response" — so verify it. A logged status the script
      // never reads let a 5xx front door stand behind a green run.
      if (!res.ok) throw new Error(`front door refused the drive: HTTP ${res.status} from ${url}`);
    },
  });

  banner("dispatch on K8s (ensure topology → per-case browser → drive → trace → grade)");
  const t0 = Date.now();
  let result;
  try {
    result = await backend.dispatch(JOB);
  } finally {
    banner("teardown");
    // "accepted" is not "gone": report which of the two happened instead of printing the deletion either way.
    const torn = await runtime
      .teardown(SPEC, perTenantTrustZones().resolve("acme"))
      .then(() => undefined)
      .catch((e) => e.message);
    console.log(torn === undefined ? "  namespace everdict-acme deleted" : `  teardown FAILED: ${torn}`);
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
  const w = delivered[0];
  console.log("thread_id     :", w?.thread_id);
  console.log("minio_prefix  :", w?.minio_prefix);
  console.log("browser_cdp_url:", w?.browser_cdp_url);

  // What this script claims is a GRADED case, not a dispatch that returned: the header says
  // "grade: real browser snapshot + trace → CaseResult". `caseOutcome` is the domain's own reading of that
  // result, so the verdict is not re-derived here; the graders the case declared must all have reported.
  const outcome = caseOutcome(result);
  const graded = new Set(result.scores.map((s) => s.graderId));
  const missing = JOB.evalCase.graders.map((g) => g.id).filter((id) => !graded.has(id));
  const problems = [];
  if (outcome.status === "completed" && !outcome.verdict) problems.push(`case ${result.caseId} FAILED its graders`);
  if (outcome.status === "unmeasured") problems.push(`case ${result.caseId} measured nothing pass-deciding`);
  if (outcome.status === "infra_failed" || outcome.status === "cancelled")
    problems.push(
      `case ${result.caseId} ${outcome.status} at stage ${outcome.failure.stage}: ${outcome.failure.code} — ${outcome.failure.message}`,
    );
  if (missing.length > 0) problems.push(`case ${result.caseId} has no score from grader(s): ${missing.join(", ")}`);
  // The per-run wiring is the thing "delivered over the network" — an empty delivery is a front door that was
  // never driven, which every "is it defined?" reading of `delivered[0] ?? {}` used to accept.
  if (w === undefined) problems.push("no per-run wiring was submitted to the front door");
  else if (!w.thread_id || !w.browser_cdp_url)
    problems.push(`per-run wiring incomplete (thread_id=${w.thread_id}, browser_cdp_url=${w.browser_cdp_url})`);

  if (problems.length > 0) {
    console.log("\nLIVE RUN FAILED:");
    for (const p of problems) console.log("  -", p);
    process.exit(1);
  }
  console.log("\n✅ the service topology ran on real K8s and the case passed every grader it declared");
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
