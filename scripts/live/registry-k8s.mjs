// Live verification: the harness version SSOT (@everdict/registry) drives a real K8s run.
//
//  - Load the file SSOT (examples/harnesses/*.json) → version list + "latest" resolution (semver)
//  - Wire ServiceTopologyBackend.specFor to the registry → job.harness.version="latest" resolves
//    to 1.1.0 in the registry and runs on kind with that spec.
//
// Usage: PATH=$HOME/.local/bin:$PATH node scripts/live/registry-k8s.mjs

import { LATEST, caseOutcome, perTenantTrustZones } from "../../packages/domain/dist/index.js";
import { loadHarnessTaxonomyDir } from "../../packages/registry/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.KUBE_CONTEXT ?? "kind-everdict";
const MLFLOW = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const DIR = new URL("../../examples/harness-templates", import.meta.url).pathname;

const banner = (s) => console.log(`\n=== ${s} ===`);

async function main() {
  banner("harness taxonomy SSOT (file-backed: templates + instances)");
  const { instances: registry } = await loadHarnessTaxonomyDir(DIR);
  const listed = await registry.list("_shared");
  for (const { id, versions } of listed) console.log(`  ${id}: ${versions.join(", ")}`);
  // An empty SSOT is not a resolution — a registry with nothing in it would let every assertion below read
  // as coverage (CLAUDE.md: an empty corpus is never a pass).
  if (listed.length === 0) throw new Error(`harness taxonomy SSOT is empty (${DIR}) — nothing to resolve`);
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
      // A logged status is not a checked one: a front door answering 5xx used to let the drive continue and
      // the case still scored, so the ✅ below could stand over a harness that was never driven.
      if (!res.ok) throw new Error(`front door refused the drive: HTTP ${res.status} from ${url}`);
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
    // "accepted" is not "gone": say which one happened instead of printing the deletion either way.
    const torn = await runtime
      .teardown(latest, perTenantTrustZones().resolve("acme"))
      .then(() => undefined)
      .catch((e) => e.message);
    console.log(torn === undefined ? "  namespace everdict-acme deleted" : `  teardown FAILED: ${torn}`);
  }

  banner("RESULT");
  console.log("harness :", result.harness, "(← resolved from version=latest)");
  console.log("scores  :", result.scores.map((s) => `${s.graderId}:${s.value}`).join(", "));

  // The claim is "the registry resolved latest → 1.1.0 AND that spec drove a real K8s run that produced a
  // verdict". A resolved harness string alone is the first half; `caseOutcome` (the domain's own reading of
  // a CaseResult) is what answers the second, so the script never re-derives a verdict of its own.
  const outcome = caseOutcome(result);
  const problems = [];
  if (result.harness !== "bu@1.1.0") problems.push(`resolved to ${result.harness}, want bu@1.1.0`);
  if (result.scores.length === 0) problems.push(`case ${result.caseId} produced no scores`);
  if (outcome.status === "completed" && !outcome.verdict) problems.push(`case ${result.caseId} FAILED its graders`);
  if (outcome.status === "unmeasured") problems.push(`case ${result.caseId} measured nothing pass-deciding`);
  if (outcome.status === "infra_failed" || outcome.status === "cancelled")
    problems.push(
      `case ${result.caseId} ${outcome.status} at stage ${outcome.failure.stage}: ${outcome.failure.code} — ${outcome.failure.message}`,
    );

  if (problems.length > 0) {
    console.log("\nLIVE RUN FAILED:");
    for (const p of problems) console.log("  -", p);
    process.exit(1);
  }
  console.log("✅ registry SSOT resolved latest → 1.1.0 and drove a real K8s run that passed its graders");
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
