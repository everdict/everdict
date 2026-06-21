// 라이브 e2e (service-topology 마지막 rung): *실제 browser-use* 를 assay 의 ServiceTopologyBackend front-door 로.
// 지금까지 토폴로지 런타임은 stub front-door 로만 deploy/drive/observe 를 검증했다(SLICE 88/89/92). 여기선 그 stub 을
// 진짜 browser-use 에이전트로 교체 — 실제 LLM(LiteLLM 프록시)이 실제 headless Chromium 을 구동해 웹 태스크를 수행하고,
// assay 의 **실 ServiceTopologyBackend.dispatch** 가 front-door 로 POST /runs(per-run wiring) → trace fetch → 브라우저
// 관측(snapshot: 방문 URL/추출 텍스트) → url-matches/dom-contains 로 결정론적 채점한다. 오케스트레이터 deploy 는 이미
// 검증됐으므로(88/89/92) 여기선 런타임을 로컬 docker 로 두고 *백엔드 경로 전체*를 실 browser-use 로 닫는다.
//
// 사전: docker build -t assay-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "gpt-5.4-mini";
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "4";
const NAME = "assay-bu-live";
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

// front-door = 실 browser-use 컨테이너 기동(--network=host 로 LiteLLM:4000 에 바로 닿게).
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
    `BROWSERUSE_MODEL=${MODEL}`,
    "-e",
    `BROWSERUSE_MAX_STEPS=${MAX_STEPS}`,
    IMAGE,
  ],
  { stdio: "ignore" },
);

let ok = false;
try {
  // health 대기(browser-use import + 서버 기동까지 수십 초 걸릴 수 있음).
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

  // 실 ServiceTopologyBackend — 런타임/트레이스는 로컬 docker front-door 를 가리키는 인라인 구현.
  const runtime = {
    id: "local-docker",
    async ensureTopology(_spec, _zone) {
      return { endpoints: { agent: FRONT } };
    },
    async provisionBrowserEnv(_spec, _runId, _zone) {
      // browser-use 가 자기 브라우저를 띄우므로 cdpUrl 은 비움. snapshot 은 front-door /observe 에서 관측.
      return {
        cdpUrl: "",
        async snapshot() {
          const r = await fetch(`${FRONT}/observe`);
          const j = await r.json();
          return { kind: "browser", url: j.url || "", dom: j.dom || "", console: [] };
        },
        async dispose() {},
      };
    },
  };
  const traceSource = {
    async fetch(_runId) {
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
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  };
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource,
    specFor: () => spec,
  });

  const job = {
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "goto-example",
      env: { kind: "browser", url: "https://example.com" },
      task: "Open https://example.com in the browser and confirm the page has loaded by reading its main heading.",
      graders: [
        { id: "url-matches", config: { pattern: "example\\.com" } },
        { id: "dom-contains", config: { text: "Example Domain" } },
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology"],
    },
  };

  console.log("\n=== ServiceTopologyBackend.dispatch — 실 browser-use 구동(LLM→실 Chromium) + 채점 ===");
  console.log("model:", MODEL, "| max_steps:", MAX_STEPS, "| task:", job.evalCase.task);
  const result = await backend.dispatch(job);

  // front-door 의 원시 관측(투명성: 에이전트 최종 답 / 에러).
  let observed = {};
  try {
    observed = await (await fetch(`${FRONT}/observe`)).json();
  } catch {}

  console.log("\n--- CaseResult ---");
  console.log("snapshot.kind =", result.snapshot.kind, "| url =", result.snapshot.url);
  console.log("snapshot.dom(앞 120):", String(result.snapshot.dom).slice(0, 120).replace(/\s+/g, " "));
  console.log("scores =", JSON.stringify(result.scores.map((s) => ({ id: s.graderId, pass: s.pass, value: s.value }))));
  console.log("browser-use result:", String(observed.result || "").slice(0, 200));
  if (observed.error) console.log("browser-use error:", String(observed.error).slice(0, 400));

  const urlOk = result.scores.find((s) => s.graderId === "url-matches")?.pass === true;
  const domOk = result.scores.find((s) => s.graderId === "dom-contains")?.pass === true;
  ok = result.snapshot.kind === "browser" && urlOk && domOk;
  console.log(
    ok
      ? "\n✅ service-topology 마지막 rung: 실제 browser-use 에이전트가 assay 의 ServiceTopologyBackend front-door 로서 " +
          "실 LLM(LiteLLM)으로 실 headless Chromium 을 구동해 https://example.com 을 방문, 백엔드가 front-door 로 POST /runs " +
          "(per-run wiring) → 브라우저 관측(snapshot: 방문 URL/추출 텍스트) → url-matches+dom-contains 로 결정론적 PASS. " +
          "stub 이 아닌 진짜 browser-use 이미지로 토폴로지 경로 전체를 닫음."
      : "\n⚠️ 기대와 불일치(아래 browser-use result/error 참고 — 모델이 태스크를 못 끝냈을 수 있음)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  if (!process.env.KEEP_IMAGE) {
    spawnSync("docker", ["builder", "prune", "-f"], { stdio: "ignore" });
  }
  console.log("cleanup done (front-door 컨테이너 제거)");
}
process.exit(ok ? 0 : 1);
