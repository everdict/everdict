// 라이브 e2e (service-topology): *실제 browser-use* 를 everdict 의 ServiceTopologyBackend front-door 로 — 로컬 docker 런타임.
// (오케스트레이터 deploy 는 kind+Nomad 로 이미 검증됐고, K8s deploy 버전은 browseruse-topology-k8s.mjs 참고.)
// 여기서 닫는 것:
//  ② 인터랙티브 멀티스텝 태스크 — 정적 example.com 이 아니라 컨테이너가 직접 서빙하는 /form 에서 navigate→input→click→
//     결과확인. url-matches(q=everdict) + dom-contains(Results for everdict) 로 결정론적 채점.
//  ③ 실 트레이스 — front-door 가 run 마다 *실제* 토큰사용량(TokenCost)+액션열(action_names)을 Jaeger(:4318)로 OTLP 배출,
//     백엔드의 traceSource(OtelTraceSource, Jaeger query :16686)가 같은 trace_id 로 끌어와 steps/cost 채점.
//     trace_id 매칭: newRunId 를 32-hex 로 오버라이드 → thread_id="run-<32hex>" → front-door 가 그 hex 를 trace_id 로 사용.
//
// 사전: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686) 기동.
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "6";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const NAME = "everdict-bu-live";
const FRONT = `http://127.0.0.1:${PORT}`;
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

function cleanup() {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}

cleanup();
console.log("=== 실 browser-use front-door 기동 (docker, --network=host) ===");
execFileSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    NAME,
    "--network=host",
    "-e",
    `PORT=${PORT}`,
    "-e",
    `OPENAI_API_KEY=${KEY}`,
    "-e",
    "OPENAI_BASE_URL=http://localhost:4000/v1",
    "-e",
    "OTLP_URL=http://localhost:4318/v1/traces",
    "-e",
    `BROWSERUSE_MODEL=${MODEL}`,
    "-e",
    `BROWSERUSE_MAX_STEPS=${MAX_STEPS}`,
    IMAGE,
  ],
  { stdio: "ignore" },
);

let ok = false;
try {
  process.stdout.write("health 대기");
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    process.stdout.write(".");
    try {
      const r = await fetch(`${FRONT}/health`);
      healthy = r.status === 200;
    } catch {}
  }
  console.log(healthy ? " up" : " (health 응답 없음)");
  if (!healthy) throw new Error("front-door health timeout");

  // 실 ServiceTopologyBackend — 런타임은 로컬 docker front-door, traceSource 는 실 Jaeger(OtelTraceSource, 인제스트 랙 retry).
  const runtime = {
    id: "local-docker",
    async ensureTopology() {
      return { endpoints: { agent: FRONT } };
    },
    async provisionBrowserEnv() {
      return {
        wiring: { target_cdp_url: "" },
        async snapshot() {
          const j = await (await fetch(`${FRONT}/observe`)).json();
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
  const spec = {
    kind: "service",
    id: "browseruse",
    version: "1.0.0",
    services: [{ name: "agent", image: IMAGE, port: Number(PORT), needs: [], perRun: [], replicas: 1 }],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
  };
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource,
    specFor: () => spec,
    newRunId: () => randomUUID().replace(/-/g, ""), // 32-hex → Jaeger trace_id 로 매칭
  });

  const job = {
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "search-form",
      env: { kind: "browser", url: `${FRONT}/form` },
      task: `Go to ${FRONT}/form , type "everdict eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
      graders: [
        { id: "url-matches", config: { pattern: "[?&]q=everdict" } }, // 제출 결과 URL
        { id: "dom-contains", config: { text: "Results for everdict" } }, // 결과 페이지 텍스트
        { id: "steps", config: {} }, // trace 기반: 실 browser-use 액션 수
        { id: "cost", config: {} }, // trace 기반: 실 토큰사용량(usd 는 프록시 모델 가격 미상→0)
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "interactive", "trace"],
    },
  };

  console.log("\n=== ServiceTopologyBackend.dispatch — 실 browser-use 인터랙티브 구동 + 실 트레이스 채점 ===");
  console.log("model:", MODEL, "| task:", job.evalCase.task);
  const result = await backend.dispatch(job);

  let observed = {};
  try {
    observed = await (await fetch(`${FRONT}/observe`)).json();
  } catch {}

  const llmCalls = result.trace.filter((e) => e.kind === "llm_call");
  const toolCalls = result.trace.filter((e) => e.kind === "tool_call");
  console.log("\n--- CaseResult ---");
  console.log("snapshot.kind =", result.snapshot.kind, "| url =", result.snapshot.url);
  console.log("snapshot.dom(앞 100):", String(result.snapshot.dom).slice(0, 100).replace(/\s+/g, " "));
  console.log("browser-use actions:", JSON.stringify(observed.actions));
  console.log("browser-use tokens :", JSON.stringify(observed.tokens), "| trace_id:", observed.trace_id);
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
  const stepsOk = (score("steps")?.value ?? 0) > 0; // 실 액션이 trace 로 들어왔는가
  const tracePulled = llmCalls.length > 0 && toolCalls.length > 0; // Jaeger 에서 끌어온 실 trace
  ok = result.snapshot.kind === "browser" && urlOk && domOk && stepsOk && tracePulled;
  console.log(
    ok
      ? "\n✅ ②+③: 실 browser-use 가 ServiceTopologyBackend front-door 로서 인터랙티브 폼을 멀티스텝(navigate→input→click)으로 " +
          "구동해 결과 페이지 도달(url-matches q=everdict + dom-contains 'Results for everdict' PASS), 동시에 run 의 실제 토큰사용량/" +
          "액션열을 Jaeger 로 OTLP 배출 → 백엔드가 OtelTraceSource 로 같은 trace_id 를 끌어와 steps(실 액션수)/cost 로 채점. " +
          "정적 데모를 넘어 인터랙티브 driving + 실 trace pull 까지 백엔드 경로로 닫음."
      : "\n⚠️ 기대와 불일치(위 actions/tokens/trace/scores 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done (front-door 컨테이너 제거)");
}
process.exit(ok ? 0 : 1);
