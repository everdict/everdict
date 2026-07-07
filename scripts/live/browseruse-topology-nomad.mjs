// 라이브 e2e (service-topology, Nomad): 실 browser-use 를 **NomadTopologyRuntime 으로 실 Nomad(dev)에 배포**해서
// ServiceTopologyBackend 로 구동. browseruse-topology-k8s.mjs(kind)와 대칭 — *오케스트레이터-비종속* 재확인: 같은
// 백엔드/하니스/태스크를 런타임만 K8s↔Nomad 로 교체. NomadTopologyRuntime.ensureTopology 가 browser-use front-door
// 잡을 등록 → alloc running 대기 → dynamic host:port 발견. 파드(alloc) 안 실 LLM(host LiteLLM)+실 chromium 이 인터랙티브
// 폼을 멀티스텝 구동하고, run 의 실 토큰/액션/USD 를 Jaeger 로 OTLP 배출 → 백엔드가 OtelTraceSource 로 끌어와 채점.
//
// 사전: nomad agent -dev (docker driver) 기동. browser-use 이미지는 호스트 docker 에 빌드돼 있어야(레지스트리 불필요,
//   Nomad docker 드라이버가 로컬 이미지 사용 — SLICE 92 stub 와 동일):
//   docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live
// 호스트 도달: Nomad docker task 는 기본 브리지 → 파드가 LiteLLM(172.17.0.1:4000)/Jaeger(172.17.0.5:4318) 도달.
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { NomadTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://localhost:4646";
const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const POD_PORT = 18080;
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "6";
const LITELLM_HOST = process.env.LITELLM_HOST ?? "172.17.0.1";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const PRICE_IN = process.env.BROWSERUSE_PRICE_IN ?? "0.00000015";
const PRICE_OUT = process.env.BROWSERUSE_PRICE_OUT ?? "0.0000006";
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

function jaegerBridgeIp() {
  if (process.env.JAEGER_IP) return process.env.JAEGER_IP;
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "everdict-jaeger", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"],
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
const OTLP_URL = `http://${jaegerBridgeIp()}:4318/v1/traces`;

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

const nomad = new NomadTopologyRuntime({
  addr: ADDR,
  readyTimeoutMs: 180000,
  storeEnv: {
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: `http://${LITELLM_HOST}:4000/v1`,
    OTLP_URL,
    BROWSERUSE_MODEL: MODEL,
    BROWSERUSE_MAX_STEPS: MAX_STEPS,
    BROWSERUSE_PRICE_IN: PRICE_IN,
    BROWSERUSE_PRICE_OUT: PRICE_OUT,
    PORT: String(POD_PORT),
  },
});

let frontDoor = "";
let ok = false;
try {
  console.log(`=== NomadTopologyRuntime.ensureTopology — 실 Nomad(${ADDR})에 browser-use front-door 배포 ===`);
  console.log(`LiteLLM=http://${LITELLM_HOST}:4000/v1 | OTLP=${OTLP_URL}`);
  const runtime = {
    id: "nomad-browseruse",
    async ensureTopology(s, zone) {
      const handle = await nomad.ensureTopology(s, zone);
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
      id: "search-form-nomad",
      env: { kind: "browser", url: `http://localhost:${POD_PORT}/form` },
      task: `Go to http://localhost:${POD_PORT}/form , type "everdict eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
      graders: [
        { id: "url-matches", config: { pattern: "[?&]q=everdict" } },
        { id: "dom-contains", config: { text: "Results for everdict" } },
        { id: "steps", config: {} },
        { id: "cost", config: {} },
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "nomad", "interactive", "trace"],
    },
  };

  console.log(
    "\n=== ServiceTopologyBackend.dispatch — Nomad alloc 의 실 browser-use 인터랙티브 구동 + 실 트레이스 채점 ===",
  );
  console.log("model:", MODEL, "| task:", job.evalCase.task);
  const result = await backend.dispatch(job);

  let observed = {};
  try {
    observed = await (await fetch(`${frontDoor}/observe`)).json();
  } catch {}
  const llmCalls = result.trace.filter((e) => e.kind === "llm_call");
  const toolCalls = result.trace.filter((e) => e.kind === "tool_call");
  console.log("\n--- CaseResult ---");
  console.log("snapshot.kind =", result.snapshot.kind, "| url =", result.snapshot.url);
  console.log("browser-use actions:", JSON.stringify(observed.actions), "| tokens:", JSON.stringify(observed.tokens));
  console.log(
    "trace(pulled from Jaeger):",
    `llm_call=${llmCalls.length}`,
    `tool_call=${toolCalls.length}`,
    llmCalls[0]
      ? `model=${llmCalls[0].model} in=${llmCalls[0].cost?.inputTokens} out=${llmCalls[0].cost?.outputTokens} usd=${llmCalls[0].cost?.usd}`
      : "",
  );
  console.log("scores =", JSON.stringify(result.scores.map((s) => ({ id: s.graderId, pass: s.pass, value: s.value }))));
  if (observed.error) console.log("front-door note:", String(observed.error).slice(0, 300));

  const score = (id) => result.scores.find((s) => s.graderId === id);
  const urlOk = score("url-matches")?.pass === true;
  const domOk = score("dom-contains")?.pass === true;
  const stepsOk = (score("steps")?.value ?? 0) > 0;
  const tracePulled = llmCalls.length > 0 && toolCalls.length > 0;
  ok = result.snapshot.kind === "browser" && urlOk && domOk && stepsOk && tracePulled;
  console.log(
    ok
      ? "\n✅ ①(Nomad): 실 browser-use 이미지를 **NomadTopologyRuntime 으로 실 Nomad(dev)에 배포**(잡 등록→alloc running→" +
          "dynamic host:port 발견)하고 ServiceTopologyBackend 로 구동 — alloc 안 실 LLM+실 chromium 이 인터랙티브 폼을 멀티스텝 " +
          "구동(url/dom PASS), 실 토큰/액션/USD 를 Jaeger 로 OTLP 배출 → OtelTraceSource 로 끌어와 steps/cost 채점. " +
          "K8s 와 대칭 — 오케스트레이터-비종속 백엔드가 Nomad 에서도 실 browser-use 를 deploy+drive+grade."
      : "\n⚠️ 기대와 불일치(위 actions/trace/scores 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  await nomad.teardown(spec).catch(() => {});
  console.log("teardown done (jobs deregistered)");
}
process.exit(ok ? 0 : 1);
