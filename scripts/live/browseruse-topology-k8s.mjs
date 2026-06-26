// 라이브 e2e (service-topology 마지막 rung, K8s): *실제 browser-use* 를 **K8sTopologyRuntime 으로 kind 에 배포**해서
// ServiceTopologyBackend 로 구동. browseruse-topology-drive.mjs(로컬 docker)와 동일한 인터랙티브+트레이스 경로를,
// 이번엔 *실 오케스트레이터 deploy* 로: K8sTopologyRuntime.ensureTopology 가 browser-use front-door 를 Deployment+Service
// 로 apply → rollout 대기 → port-forward 로 발견. front-door 파드 안에서 실 LLM(host LiteLLM)+실 chromium 이 폼을
// 멀티스텝 구동하고, run 의 실 토큰/액션을 Jaeger(브리지)로 OTLP 배출 → 백엔드가 OtelTraceSource 로 끌어와 채점.
//
// 사전(dev kind 호스트 도달 레시피, aider-k8s 와 동일):
//   - kind 노드를 기본 도커 브리지에 연결 → 파드가 호스트 LiteLLM(172.17.0.1:4000) 도달(이 스크립트가 idempotent 하게 수행).
//   - Jaeger(assay-jaeger)는 기본 브리지 컨테이너 → 파드는 그 브리지 IP:4318 로 OTLP 배출, 호스트는 :16686 으로 pull.
//   - 이미지 kind 로드: 이 스크립트가 `kind load docker-image assay-browseruse:demo --name assay` 수행.
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { K8sTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const CONTEXT = process.env.K8S_CONTEXT ?? "kind-assay";
const CLUSTER = process.env.KIND_CLUSTER ?? "assay";
const NODE = process.env.KIND_NODE ?? "assay-control-plane";
const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const POD_PORT = 18080; // front-door 컨테이너 내부 포트(파드 localhost). chromium 이 같은 파드에서 이 포트로 폼 접근.
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "6";
const LITELLM_HOST = process.env.LITELLM_HOST ?? "172.17.0.1"; // 기본 브리지 게이트웨이 = 호스트
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686"; // 호스트(127.0.0.1 published)에서 pull
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Jaeger 의 기본 브리지 IP(파드가 OTLP 배출할 대상). assay-jaeger 컨테이너에서 동적 조회.
function jaegerBridgeIp() {
  if (process.env.JAEGER_IP) return process.env.JAEGER_IP;
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
        .find((ip) => /^172\.17\./.test(ip)) ??
      out.trim().split(/\s+/)[0] ??
      ""
    ).trim();
  } catch {
    return "";
  }
}
const JAEGER_IP = jaegerBridgeIp();
const OTLP_URL = JAEGER_IP ? `http://${JAEGER_IP}:4318/v1/traces` : "http://172.17.0.5:4318/v1/traces";

console.log("=== dev 호스트 도달 셋업(노드↔기본 브리지) + kind 이미지 로드 ===");
spawnSync("docker", ["network", "connect", "bridge", NODE], { stdio: "ignore" }); // idempotent (이미 연결이면 무해)
console.log(`LiteLLM=http://${LITELLM_HOST}:4000/v1 | OTLP=${OTLP_URL}`);
console.log(`kind load ${IMAGE} → cluster ${CLUSTER} (수 분 소요 가능) …`);
execFileSync("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER], { stdio: "ignore" });
console.log("loaded.");

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
  storeEnv: {
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://${LITELLM_HOST}:4000/v1`,
    OTLP_URL,
    BROWSERUSE_MODEL: MODEL,
    BROWSERUSE_MAX_STEPS: MAX_STEPS,
    PORT: String(POD_PORT),
  },
});

let frontDoor = ""; // ensureTopology 가 발견한 port-forward 엔드포인트(호스트). provisionBrowserEnv 의 /observe 에서 사용.
let ok = false;
try {
  console.log(`\n=== K8sTopologyRuntime.ensureTopology — kind(${CONTEXT})에 browser-use front-door 배포 ===`);
  // 어댑터 런타임: deploy/discover 는 실 K8sTopologyRuntime, per-case 관측은 front-door /observe(browser-use 가 자기
  // 브라우저를 띄우므로 별도 chromedp 파드 대신 front-door 관측을 쓴다 — local docker 경로와 동일).
  const runtime = {
    id: "k8s-browseruse",
    async ensureTopology(s, zone) {
      const handle = await k8s.ensureTopology(s, zone);
      frontDoor = handle.endpoints[s.frontDoor.service];
      console.log("discovered front-door endpoint:", frontDoor);
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
      for (let i = 0; i < 25; i++) {
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
    newRunId: () => randomUUID().replace(/-/g, ""),
  });

  const job = {
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "search-form-k8s",
      env: { kind: "browser", url: `http://localhost:${POD_PORT}/form` },
      task: `Go to http://localhost:${POD_PORT}/form , type "assay eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
      graders: [
        { id: "url-matches", config: { pattern: "[?&]q=assay" } },
        { id: "dom-contains", config: { text: "Results for assay" } },
        { id: "steps", config: {} },
        { id: "cost", config: {} },
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "k8s", "interactive", "trace"],
    },
  };

  console.log(
    "\n=== ServiceTopologyBackend.dispatch — kind 파드의 실 browser-use 인터랙티브 구동 + 실 트레이스 채점 ===",
  );
  console.log("model:", MODEL, "| task:", job.evalCase.task);
  const result = await backend.dispatch(job); // ← ensureTopology 가 ns+Deployment 를 만들고 구동까지

  // 실 클러스터 배포 증거(dispatch 가 만든 뒤, teardown 전에 조회).
  const k = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });
  let ready = "";
  try {
    ready = k([
      "get",
      "deploy",
      "browseruse-agent",
      "-n",
      "assay-default",
      "-o",
      "jsonpath={.status.readyReplicas}/{.status.replicas}",
    ]);
  } catch {}
  console.log("k8s deploy browseruse-agent ready:", ready);

  let observed = {};
  try {
    observed = await (await fetch(`${frontDoor}/observe`)).json();
  } catch {}
  const llmCalls = result.trace.filter((e) => e.kind === "llm_call");
  const toolCalls = result.trace.filter((e) => e.kind === "tool_call");
  console.log("\n--- CaseResult ---");
  console.log("snapshot.kind =", result.snapshot.kind, "| url =", result.snapshot.url);
  console.log("snapshot.dom(앞 100):", String(result.snapshot.dom).slice(0, 100).replace(/\s+/g, " "));
  console.log("browser-use actions:", JSON.stringify(observed.actions), "| tokens:", JSON.stringify(observed.tokens));
  console.log(
    "trace(pulled from Jaeger):",
    `llm_call=${llmCalls.length}`,
    `tool_call=${toolCalls.length}`,
    llmCalls[0]
      ? `model=${llmCalls[0].model} in=${llmCalls[0].cost?.inputTokens} out=${llmCalls[0].cost?.outputTokens}`
      : "",
  );
  console.log("scores =", JSON.stringify(result.scores.map((s) => ({ id: s.graderId, pass: s.pass, value: s.value }))));
  if (observed.error) console.log("front-door note:", String(observed.error).slice(0, 300));

  const score = (id) => result.scores.find((s) => s.graderId === id);
  const urlOk = score("url-matches")?.pass === true;
  const domOk = score("dom-contains")?.pass === true;
  const stepsOk = (score("steps")?.value ?? 0) > 0;
  const tracePulled = llmCalls.length > 0 && toolCalls.length > 0;
  ok = ready.startsWith("1") && result.snapshot.kind === "browser" && urlOk && domOk && stepsOk && tracePulled;
  console.log(
    ok
      ? "\n✅ ①: 실 browser-use 이미지를 **K8sTopologyRuntime 으로 kind 에 배포**(Deployment+Service apply→rollout→port-forward) " +
          "하고 ServiceTopologyBackend 로 구동 — 파드 안 실 LLM(host LiteLLM)+실 chromium 이 인터랙티브 폼을 멀티스텝 구동해 " +
          "결과 도달(url/dom PASS), run 의 실 토큰/액션을 Jaeger(브리지)로 OTLP 배출 → OtelTraceSource 로 끌어와 steps/cost 채점. " +
          "오케스트레이터 deploy 까지 실 K8s 경로로 닫음."
      : "\n⚠️ 기대와 불일치(위 ready/actions/trace/scores 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  await k8s.teardown(spec).catch(() => {});
  console.log("teardown done (forwards stopped, ns deleted)");
}
process.exit(ok ? 0 : 1);
