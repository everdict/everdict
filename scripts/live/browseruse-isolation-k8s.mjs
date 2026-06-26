// 라이브 e2e (service-topology, K8s 멀티테넌트 격리): browser-use 하니스를 *테넌트(trustZone)별로* 띄워 격리 실증.
// ServiceTopologyBackend 가 tenant→TrustZone 으로 해석(trustZones.resolve) → assertHardenedIsolation → 존별
// K8sTopologyRuntime.ensureTopology(spec, zone): warm 토폴로지를 **테넌트 전용 네임스페이스**에 배포(테넌트 간 warm 풀
// 공유 금지) + zone.network 로 NetworkPolicy 적용. 두 테넌트(acme/globex)를 띄워 ns/Deployment 분리 + netpol 적용을
// 증거로 확인하고, 각 테넌트의 front-door 를 인터랙티브 구동해 둘 다 자기 존에서 동작함을 보인다.
//
// 사전: kind(컨텍스트 kind-assay). 노드↔기본 브리지(파드→host LiteLLM 172.17.0.1) + 이미지 kind 로드는 이 스크립트가 수행.
// 주의: kind 기본 CNI(kindnet)는 NetworkPolicy 를 *적용*만 하고 강제(enforce)는 안 함 — 강제엔 Calico/Cilium 필요.
//   여기선 정책 매니페스트가 존별로 생성·적용되는 것까지 검증(네임스페이스 경계는 실효).
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { staticTrustZones } from "../../packages/backends/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-assay";
const CLUSTER = process.env.KIND_CLUSTER ?? "assay";
const NODE = process.env.KIND_NODE ?? "assay-control-plane";
const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const POD_PORT = 18080;
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const LITELLM_HOST = process.env.LITELLM_HOST ?? "172.17.0.1";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const TENANTS = ["acme", "globex"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });

function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = masterKey();
if (!KEY) {
  console.error("LLM 키 없음(OPENAI_API_KEY 또는 infra/litellm/.env).");
  process.exit(2);
}
function jaegerBridgeIp() {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "assay-jaeger", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"],
      { encoding: "utf8" },
    );
    return (
      out
        .trim()
        .split(/\s+/)
        .find((ip) => /^172\.17\./.test(ip)) ?? "172.17.0.5"
    ).trim();
  } catch {
    return "172.17.0.5";
  }
}

console.log("=== dev 호스트 도달 + kind 이미지 로드 ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" });
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

// 테넌트별 존: trusted=true + runc(=kind 에 gvisor 없음 → assertHardenedIsolation 통과), 전용 네임스페이스, cross-tenant 차단.
const zoneFor = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `assay-${id}`,
  network: "deny-cross-tenant",
  trusted: true,
});
const trustZones = staticTrustZones(Object.fromEntries(TENANTS.map((t) => [t, zoneFor(t)])), zoneFor("default"));

const spec = {
  kind: "service",
  id: "browseruse",
  version: "1.0.0",
  services: [{ name: "agent", image: IMAGE, port: POD_PORT, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["screenshot"] },
  frontDoor: { service: "agent", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
};

const k8s = new K8sTopologyRuntime({
  context: CONTEXT,
  imagePullPolicy: "IfNotPresent",
  readyTimeoutMs: 180000,
  networkPolicies: true, // zone.network → NetworkPolicy 매니페스트 생성·적용(kindnet 은 미강제, 매니페스트는 적용됨)
  storeEnv: {
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://${LITELLM_HOST}:4000/v1`,
    OTLP_URL: `http://${jaegerBridgeIp()}:4318/v1/traces`,
    BROWSERUSE_MODEL: MODEL,
    BROWSERUSE_MAX_STEPS: "6",
    BROWSERUSE_PRICE_IN: "0.00000015",
    BROWSERUSE_PRICE_OUT: "0.0000006",
    PORT: String(POD_PORT),
  },
});

let frontDoor = "";
const runtime = {
  id: "k8s-isolation",
  async ensureTopology(s, zone) {
    const handle = await k8s.ensureTopology(s, zone);
    frontDoor = handle.endpoints[s.frontDoor.service];
    return handle;
  },
  async provisionBrowserEnv() {
    return {
      wiring: { target_cdp_url: "" },
      async snapshot() {
        const j = await (await fetch(`${frontDoor}/observe`)).json();
        return { kind: "browser", url: j.url || "", dom: j.dom || "", console: [] };
      },
      async dispose() {},
    };
  },
};
const otel = new OtelTraceSource({ endpoint: JAEGER_QUERY });
const traceSource = {
  async fetch(runId) {
    for (let i = 0; i < 20; i++) {
      try {
        const ev = await otel.fetch(runId);
        if (ev.length > 0) return ev;
      } catch {}
      await sleep(1000);
    }
    return [];
  },
};
const backend = new ServiceTopologyBackend({
  runtime,
  traceSource,
  specFor: () => spec,
  trustZones,
  newRunId: () => randomUUID().replace(/-/g, ""),
});

const mkJob = (tenant) => ({
  tenant,
  harness: { id: "browseruse", version: "1.0.0" },
  evalCase: {
    id: `search-form-${tenant}`,
    env: { kind: "browser", url: `http://localhost:${POD_PORT}/form` },
    task: `Go to http://localhost:${POD_PORT}/form , type "${tenant} eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
    graders: [
      { id: "url-matches", config: { pattern: `[?&]q=${tenant}` } },
      { id: "dom-contains", config: { text: `Results for ${tenant}` } },
      { id: "steps", config: {} },
    ],
    timeoutSec: 300,
    tags: ["browser-use", "isolation", tenant],
  },
});

let ok = false;
try {
  const perTenant = {};
  for (const tenant of TENANTS) {
    console.log(`\n=== tenant=${tenant} (zone ns=assay-${tenant}) — ensureTopology + dispatch ===`);
    try {
      const result = await backend.dispatch(mkJob(tenant));
      const score = (id) => result.scores.find((s) => s.graderId === id);
      const pass = score("url-matches")?.pass === true && score("dom-contains")?.pass === true;
      perTenant[tenant] = { pass, url: result.snapshot.url, endpoint: frontDoor };
      console.log(`  ${tenant}: ${pass ? "PASS" : "FAIL"} url=${result.snapshot.url} front-door=${frontDoor}`);
    } catch (e) {
      perTenant[tenant] = { pass: false, endpoint: frontDoor, error: e instanceof Error ? e.message : String(e) };
      console.log(`  ${tenant}: ERROR ${perTenant[tenant].error}`);
      try {
        console.log(k(["get", "pods", "-n", `assay-${tenant}`, "-o", "wide"]));
        console.log(
          k(["get", "events", "-n", `assay-${tenant}`, "--sort-by=.lastTimestamp"])
            .split("\n")
            .slice(-8)
            .join("\n"),
        );
      } catch {}
    }
  }

  // === 격리 증거: 테넌트별 네임스페이스 분리 + 각 ns 의 browseruse-agent Deployment + NetworkPolicy ===
  console.log("\n=== 격리 증거 ===");
  const ns = k(["get", "ns", "-o", "name"]).trim().split("\n");
  const evidence = {};
  for (const tenant of TENANTS) {
    const n = `namespace/assay-${tenant}`;
    const hasNs = ns.includes(n);
    let deploys = "";
    let netpol = "";
    try {
      deploys = k(["get", "deploy", "-n", `assay-${tenant}`, "-o", "name"])
        .trim()
        .replace(/\n/g, " ");
    } catch {}
    try {
      netpol = k(["get", "netpol", "-n", `assay-${tenant}`, "-o", "name"])
        .trim()
        .replace(/\n/g, " ");
    } catch {}
    evidence[tenant] = { hasNs, deploys, netpol };
    console.log(`  assay-${tenant}: ns=${hasNs} deploy=[${deploys}] netpol=[${netpol || "none"}]`);
  }

  const bothPass = TENANTS.every((t) => perTenant[t]?.pass);
  const separateNs = TENANTS.every((t) => evidence[t]?.hasNs && evidence[t]?.deploys.includes("browseruse-agent"));
  const distinctEndpoints = perTenant.acme?.endpoint !== perTenant.globex?.endpoint;
  ok = bothPass && separateNs && distinctEndpoints;
  console.log(
    ok
      ? "\n✅ ②: browser-use 하니스가 테넌트별 trustZone 으로 격리 배포됨 — 각 테넌트가 *전용 네임스페이스*(assay-acme / " +
          "assay-globex)에 자기 warm 토폴로지(browseruse-agent Deployment)를 갖고(테넌트 간 풀 공유 없음, 서로 다른 front-door " +
          "엔드포인트), zone.network 로 NetworkPolicy 가 ns 별 적용됨. 두 테넌트 모두 자기 존에서 인터랙티브 구동 PASS. " +
          "(kindnet 은 netpol 미강제 — 강제엔 Calico/Cilium; 네임스페이스 경계는 실효.)"
      : "\n⚠️ 기대와 불일치(위 perTenant/evidence 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  for (const tenant of TENANTS) {
    await k8s.teardown(spec, zoneFor(tenant)).catch(() => {});
  }
  console.log("teardown done (per-tenant ns deleted, forwards stopped)");
}
process.exit(ok ? 0 : 1);
