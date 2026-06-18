// 라이브 검증: 하니스 버전 SSOT(@assay/registry)가 실제 K8s 실행을 구동한다.
//
//  - 파일 SSOT(examples/harnesses/*.json)를 로드 → 버전 목록 + "latest" 해석(semver)
//  - ServiceTopologyBackend.specFor 를 레지스트리로 연결 → job.harness.version="latest" 가
//    레지스트리에서 1.1.0 으로 해석되어 그 스펙으로 kind 에서 실행된다.
//
// 사용: PATH=$HOME/.local/bin:$PATH node scripts/live/registry-k8s.mjs

import { perTenantTrustZones } from "../../packages/backends/dist/index.js";
import { LATEST, loadHarnessDir } from "../../packages/registry/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { MlflowTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.KUBE_CONTEXT ?? "kind-assay";
const MLFLOW = process.env.MLFLOW_ENDPOINT ?? "http://127.0.0.1:5501";
const DIR = new URL("../../examples/harnesses", import.meta.url).pathname;

const banner = (s) => console.log(`\n=== ${s} ===`);

async function main() {
  banner("harness version SSOT (file-backed)");
  const registry = loadHarnessDir(DIR);
  for (const { id, versions } of registry.list()) console.log(`  ${id}: ${versions.join(", ")}`);
  const latest = registry.getService("bu", LATEST);
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
    specFor: (id, ref) => registry.getService(id, ref), // ← 레지스트리가 spec 의 SSOT
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

  // job 은 "latest" 만 참조 — 레지스트리가 1.1.0 으로 해석한다.
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
    console.log("  namespace assay-acme deleted");
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
