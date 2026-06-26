// 라이브 e2e (service-topology): 실 browser-use 를 *외부 실사이트*에 멀티스텝으로 — 성공률 측정 + 실 cost(USD).
// ②: 컨테이너 자체 폼이 아니라 https://en.wikipedia.org 에서 검색→기사 진입. 더 강한 모델(chatgpt/gpt-5.4)로 N 회
//    반복해 통과율(url-matches+dom-contains)을 측정. 실 인터넷 사이트라 모델 driving 강도가 훨씬 높다.
// ③: front-door 가 실 토큰사용량(TokenCost)에 단가(LiteLLM /model/info → 운영자 env BROWSERUSE_PRICE_*)를 곱해 USD
//    를 산정 → OTLP llm_call.cost.usd 로 배출 → cost 그레이더가 실 USD 합산. (프록시 모델은 LiteLLM 가격이 0 이므로
//    운영자 지정 *참조단가*를 env 로 준다 — 실제 cost 산정 방식과 동일. 토큰은 실값, 단가는 운영자 입력, USD 는 실산술.)
//
// 사전: docker build -t assay-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686) 기동.
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4"; // 더 강한 모델
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "10"; // 실사이트는 스텝 여유
const RUNS = Number(process.env.RUNS ?? "3");
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
// 운영자 지정 참조단가($/token) — LiteLLM 에 가격 미설정 시 사용. 기본은 공개 mini 급 참조가격(IN $0.15/1M, OUT $0.60/1M).
const PRICE_IN = process.env.BROWSERUSE_PRICE_IN ?? "0.00000015";
const PRICE_OUT = process.env.BROWSERUSE_PRICE_OUT ?? "0.0000006";
const NAME = "assay-bu-realsite";
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
const cleanup = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });

cleanup();
console.log(`=== 실 browser-use front-door 기동 (docker, --network=host, model=${MODEL}) ===`);
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
    "-e",
    `BROWSERUSE_PRICE_IN=${PRICE_IN}`,
    "-e",
    `BROWSERUSE_PRICE_OUT=${PRICE_OUT}`,
    IMAGE,
  ],
  { stdio: "ignore" },
);

let passes = 0;
const rows = [];
try {
  process.stdout.write("health 대기");
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    process.stdout.write(".");
    try {
      healthy = (await fetch(`${FRONT}/health`)).status === 200;
    } catch {}
  }
  console.log(healthy ? " up" : " (no health)");
  if (!healthy) throw new Error("front-door health timeout");

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
    newRunId: () => randomUUID().replace(/-/g, ""),
  });

  const task =
    "Go to https://en.wikipedia.org , use the search box to search for 'Web scraping', and open the Wikipedia " +
    "article titled 'Web scraping'. Report the article title.";
  const mkJob = () => ({
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "wikipedia-search",
      env: { kind: "browser", url: "https://en.wikipedia.org" },
      task,
      graders: [
        { id: "url-matches", config: { pattern: "wikipedia\\.org/wiki/Web_scraping" } },
        { id: "dom-contains", config: { text: "Web scraping" } },
        { id: "steps", config: {} },
        { id: "cost", config: {} },
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "realsite", "trace"],
    },
  });

  console.log(`\n=== 외부 실사이트(Wikipedia) ${RUNS}회 — 성공률 + 실 cost 측정 ===`);
  console.log("task:", task);
  for (let n = 1; n <= RUNS; n++) {
    let result;
    try {
      result = await backend.dispatch(mkJob());
    } catch (e) {
      console.log(`run ${n}: dispatch error ${e instanceof Error ? e.message : e}`);
      rows.push({ n, pass: false });
      continue;
    }
    let observed = {};
    try {
      observed = await (await fetch(`${FRONT}/observe`)).json();
    } catch {}
    const score = (id) => result.scores.find((s) => s.graderId === id);
    const urlOk = score("url-matches")?.pass === true;
    const domOk = score("dom-contains")?.pass === true;
    const pass = result.snapshot.kind === "browser" && urlOk && domOk;
    if (pass) passes++;
    const llm = result.trace.find((e) => e.kind === "llm_call");
    const usd = result.scores.find((s) => s.graderId === "cost")?.value ?? 0;
    rows.push({
      n,
      pass,
      url: result.snapshot.url,
      actions: (observed.actions || []).length,
      tokens: observed.tokens,
      steps: score("steps")?.value,
      usd,
      llmTokens: llm ? `${llm.cost?.inputTokens}/${llm.cost?.outputTokens}` : "-",
    });
    console.log(
      `run ${n}: ${pass ? "PASS" : "FAIL"} | url=${result.snapshot.url} | actions=${(observed.actions || []).length}` +
        ` | tokens=${JSON.stringify(observed.tokens)} | cost(grader)=$${Number(usd).toFixed(6)}`,
    );
  }

  console.log("\n--- 요약 ---");
  console.table(rows);
  const rate = ((passes / RUNS) * 100).toFixed(0);
  console.log(`성공률: ${passes}/${RUNS} (${rate}%) | model=${MODEL}`);
  console.log(
    `cost: 실 토큰 × 단가(LiteLLM /model/info 또는 운영자 참조단가 IN=${PRICE_IN}/OUT=${PRICE_OUT} $/token) = 실 USD. 프록시 모델은 LiteLLM 가격이 0 이라 운영자 참조단가를 사용(토큰은 실값, USD 는 실산술).`,
  );
  console.log(
    passes > 0
      ? "\n✅ ②③: 실 browser-use 가 외부 실사이트(Wikipedia)를 멀티스텝 구동(검색→기사) — 성공/실패를 백엔드가 결정론적으로 " +
          "채점해 성공률 산출, 동시에 실 토큰사용량에 단가를 곱한 USD 를 trace 로 끌어와 cost 그레이더가 실값 합산."
      : "\n⚠️ 전부 실패 — 위 run 로그/모델 확인",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(passes > 0 ? 0 : 1);
