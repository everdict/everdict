// Live verification: the harness version SSOT (@everdict/registry) drives a real K8s run.
//
//  - Load the file SSOT (examples/harnesses/*.json) → version list + "latest" resolution (semver)
//  - Wire ServiceTopologyBackend.specFor to the registry → job.harness.version="latest" resolves
//    to 1.1.0 in the registry and runs on kind with that spec.
//
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/registry-k8s.mjs

import { perTenantTrustZones } from "../../packages/backends/dist/index.js";
import { LATEST, loadHarnessTaxonomyDir } from "../../packages/registry/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.KUBE_CONTEXT ?? "kind-everdict";
const MLFLOW = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const DIR = new URL("../../examples/harness-templates", import.meta.url).pathname;

const banner = (s) => console.log(`\n=== ${s} ===`);

async function main() {
  banner("harness taxonomy SSOT (file-backed: templates + instances)");
  const { instances: registry } = await loadHarnessTaxonomyDir(DIR);
  for (const { id, versions } of await registry.list("_shared")) console.log(`  ${id}: ${versions.join(", ")}`);
  const latest = await registry.getService("acme", "bu", LATEST);
  console.log(
    `  resolve bu@latest → ${latest.id}@${latest.version}  (deps: ${latest.dependencies.map((d) => d.store).join("+")})`,
  );

  const runtime = new K8sTopologyRuntime({
    context: CONTEXT,
    browserImage: "chromedp/headless-shell:latest",
    imagePullPolicy: "IfNotPresent",
    readyTimeoutMs: 120_000,
    pollIntervalMs: 1500,
  });

  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: new MlflowTraceSource({ endpoint: MLFLOW }),
    specFor: (tenant, id, ref) => registry.getService(tenant, id, ref), // ← the registry is the SSOT for the spec
    trustZones: perTenantTrustZones(),
    submit: async (url, payload) => {
      console.log(`  → POST ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`    front-door responded: HTTP ${res.status}`);
    },
  });

  // the job only references "latest" — the registry resolves it to 1.1.0.
  const job = {
    harness: { id: "bu", version: LATEST },
    tenant: "acme",
    evalCase: {
      id: "registry-k8s-1",
      env: { kind: "browser", startUrl: "about:blank" },
      task: "run via registry-resolved spec",
      graders: [{ id: "url-matches", config: { pattern: "about:blank" } }, { id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "registry"],
    },
  };

  banner("dispatch on K8s with registry-resolved spec (version=latest)");
  let result;
  try {
    result = await backend.dispatch(job);
  } finally {
    banner("teardown");
    await runtime
      .teardown(latest, perTenantTrustZones().resolve("acme"))
      .catch((e) => console.log("  teardown:", e.message));
    console.log("  namespace everdict-acme deleted");
  }

  banner("RESULT");
  console.log("harness :", result.harness, "(← resolved from version=latest)");
  console.log("scores  :", result.scores.map((s) => `${s.graderId}:${s.value}`).join(", "));
  console.log(
    result.harness === "bu@1.1.0"
      ? "✅ registry SSOT resolved latest → 1.1.0 and drove a real K8s run"
      : `ℹ resolved to ${result.harness}`,
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
