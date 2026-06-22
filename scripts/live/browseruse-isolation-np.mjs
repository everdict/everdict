// 라이브 e2e (service-topology, NetworkPolicy 강제): browser-use 두 테넌트를 *Calico 클러스터(kind-assay-np)*에 띄워
// deny-cross-tenant NetworkPolicy 가 실제로 교차 테넌트 트래픽을 *차단*함을 검증. browseruse-isolation-k8s.mjs(kindnet,
// 정책 미강제)와 달리 여기선 Calico 가 정책을 enforce → acme 파드 → globex 의 browseruse-agent 서비스 = BLOCKED,
// 같은 ns = REACHABLE. (network-isolation-k8s.mjs 가 echo 서비스로 증명한 enforce 를 browser-use front-door 로.)
//
// 사전: kind-assay-np (Calico CNI). 이미지 kind 로드 + 노드↔기본 브리지(파드→host LiteLLM)는 이 스크립트가 수행.
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { staticTrustZones } from "../../packages/backends/dist/index.js";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-assay-np";
const CLUSTER = process.env.KIND_CLUSTER ?? "assay-np";
const NODE = process.env.KIND_NODE ?? "assay-np-control-plane";
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

// ns 안에서 curl 파드로 대상 서비스 도달 여부 측정(REACHABLE/BLOCKED).
function probe(ns, url) {
  const pod = `probe-${Math.floor(Number(`0x${randomUUID().slice(0, 6)}`))}`;
  try {
    const out = execFileSync(
      "kubectl",
      [
        "--context",
        CONTEXT,
        "run",
        pod,
        "-n",
        ns,
        "--rm",
        "-i",
        "--restart=Never",
        "--image=curlimages/curl:latest",
        "--command",
        "--",
        "sh",
        "-c",
        `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 ${url} 2>/dev/null); [ "$code" = "200" ] && echo REACHABLE || echo BLOCKED`,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    return out.includes("REACHABLE") ? "REACHABLE" : "BLOCKED";
  } catch {
    return "BLOCKED";
  }
}

console.log("=== dev 호스트 도달 + kind 이미지 로드 (kind-assay-np, Calico) ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" });
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

const zoneFor = (id) => ({
  id,
  isolationRuntime: "runc",
  namespace: `assay-np-${id}`,
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
  networkPolicies: true,
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
  id: "k8s-np",
  async ensureTopology(s, zone) {
    const handle = await k8s.ensureTopology(s, zone);
    frontDoor = handle.endpoints[s.frontDoor.service];
    return handle;
  },
  async provisionBrowserEnv() {
    return {
      cdpUrl: "",
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
    ],
    timeoutSec: 300,
    tags: ["browser-use", "isolation-np", tenant],
  },
});

let ok = false;
try {
  // 두 테넌트 배포 + 각자 자기 존에서 인터랙티브 구동(둘 다 동작).
  const drive = {};
  for (const tenant of TENANTS) {
    console.log(`\n=== tenant=${tenant} (ns=assay-np-${tenant}) — deploy + drive ===`);
    try {
      const r = await backend.dispatch(mkJob(tenant));
      const score = (id) => r.scores.find((s) => s.graderId === id);
      drive[tenant] = score("url-matches")?.pass === true && score("dom-contains")?.pass === true;
      console.log(`  ${tenant}: drive ${drive[tenant] ? "PASS" : "FAIL"} url=${r.snapshot.url}`);
    } catch (e) {
      drive[tenant] = false;
      console.log(`  ${tenant}: ERROR ${e instanceof Error ? e.message : e}`);
    }
  }

  // === NetworkPolicy 강제 검증(Calico): 같은-ns 도달 vs 교차-테넌트 차단 ===
  console.log("\n=== NetworkPolicy 강제 검증 (Calico) ===");
  const svc = (t) => `http://browseruse-agent.assay-np-${t}:${POD_PORT}/health`;
  const sameNs = probe("assay-np-acme", svc("acme")); // acme 파드 → acme 서비스(같은 ns) → 허용돼야
  const crossNs = probe("assay-np-acme", svc("globex")); // acme 파드 → globex 서비스(교차) → 차단돼야
  console.log(`  acme→acme   (same-ns) : ${sameNs}   <-- 허용돼야 함`);
  console.log(`  acme→globex (cross)   : ${crossNs}   <-- 차단돼야 함`);

  const enforce = sameNs === "REACHABLE" && crossNs === "BLOCKED";
  ok = drive.acme && drive.globex && enforce;
  console.log(
    ok
      ? "\n✅ ②: browser-use 두 테넌트를 Calico 클러스터(kind-assay-np)에 전용 네임스페이스로 배포(둘 다 자기 존에서 구동 PASS), " +
          "deny-cross-tenant NetworkPolicy 가 **실제로 강제**됨 — 같은-ns 파드는 browseruse-agent 서비스 도달(REACHABLE), " +
          "교차-테넌트 파드는 차단(BLOCKED). kindnet(미강제)과 달리 Calico 가 정책을 enforce 하여 테넌트 경계가 네트워크 레벨로 실효."
      : `\n⚠️ 기대와 불일치 (drive acme=${drive.acme} globex=${drive.globex}, same=${sameNs}, cross=${crossNs})`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  for (const tenant of TENANTS) {
    await k8s.teardown(spec, zoneFor(tenant)).catch(() => {});
  }
  console.log("teardown done (per-tenant ns deleted)");
}
process.exit(ok ? 0 : 1);
