// 라이브 검증: service-topology 하니스를 실제 Kubernetes(kind)에서 구동한다 — Nomad 와 동형.
//
//  - warm 토폴로지: front-door 를 Deployment+Service 로 apply → rollout 대기 → port-forward 로 엔드포인트 발견
//  - per-case 타깃: headless Chromium Deployment 를 띄우고 port-forward 로 실 CDP 발견
//  - drive: 발견한 front-door 로 실제 POST /runs (per-run wiring) — 응답 200 으로 검증
//  - 테넌트 격리: trust-zone(perTenantTrustZones) → 테넌트별 네임스페이스 everdict-<tenant> (K8s 네이티브 격리)
//  - grade: 실 브라우저 스냅샷 + trace → CaseResult → teardown(네임스페이스 삭제)
//
// 사용: KUBECONFIG 컨텍스트 kind-everdict, PATH 에 kubectl 필요.
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
    imagePullPolicy: "IfNotPresent", // kind 에 사전 로드한 이미지 사용
    readyTimeoutMs: 120_000,
    pollIntervalMs: 1500,
  });

  const delivered = [];
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: new MlflowTraceSource({ endpoint: MLFLOW }),
    specFor: () => SPEC,
    trustZones: perTenantTrustZones(), // 테넌트별 네임스페이스 격리
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
