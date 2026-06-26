// 라이브 e2e (service-topology): browser-use 하니스로 *멀티-케이스 스코어카드* + 모델 A/B diff.
// 데이터셋(여러 web 태스크)을 두 모델(gpt-5.4-mini vs chatgpt/gpt-5.4 = 두 하니스 버전)로 각각 돌려 CaseResult[] 를
// Scorecard 로 모으고, summarizeScorecard(메트릭별 통과율/평균 cost·steps) + diffScorecards(pass 전이 회귀/개선 + 메트릭
// delta)로 A/B 비교. = 컨트롤플레인의 ScorecardService(runSuite→summarize→diff) 가 하는 일을 실 browser-use 로.
//
// 사전: docker build -t assay-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { diffScorecards, summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const PRICE_IN = process.env.BROWSERUSE_PRICE_IN ?? "0.00000015";
const PRICE_OUT = process.env.BROWSERUSE_PRICE_OUT ?? "0.0000006";
const NAME = "assay-bu-scorecard";
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

// 데이터셋 — 여러 web 태스크(컨테이너 폼 검색 2종 + 외부 Wikipedia 1종). caseId 는 모델 간 동일(diff 매칭용).
const DATASET = [
  {
    id: "form-assay",
    env: { kind: "browser", url: `${FRONT}/form` },
    task: `Go to ${FRONT}/form , type "assay eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
    graders: [
      { id: "url-matches", config: { pattern: "[?&]q=assay" } },
      { id: "dom-contains", config: { text: "Results for assay" } },
      { id: "steps", config: {} },
      { id: "cost", config: {} },
    ],
  },
  {
    id: "form-vectordb",
    env: { kind: "browser", url: `${FRONT}/form` },
    task: `Go to ${FRONT}/form , type "vector database" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
    graders: [
      { id: "url-matches", config: { pattern: "[?&]q=vector" } },
      { id: "dom-contains", config: { text: "Results for vector" } },
      { id: "steps", config: {} },
      { id: "cost", config: {} },
    ],
  },
  {
    id: "wiki-scraping",
    env: { kind: "browser", url: "https://en.wikipedia.org" },
    task: "Go to https://en.wikipedia.org , use the search box to search for 'Web scraping', and open the Wikipedia article titled 'Web scraping'. Report the article title.",
    graders: [
      { id: "url-matches", config: { pattern: "wikipedia\\.org/wiki/Web_scraping" } },
      { id: "dom-contains", config: { text: "Web scraping" } },
      { id: "steps", config: {} },
      { id: "cost", config: {} },
    ],
  },
];

function makeBackend(version) {
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
    version,
    services: [{ name: "agent", image: IMAGE, port: Number(PORT), needs: [], perRun: [], replicas: 1 }],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
  };
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    specFor: () => spec,
    newRunId: () => randomUUID().replace(/-/g, ""),
  });
}

// 한 모델(=하니스 버전)로 데이터셋 전체 → Scorecard.
async function runModel(model, version) {
  cleanup();
  console.log(`\n### 하니스 browseruse@${version} (model=${model}) — ${DATASET.length} 케이스 ###`);
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
      `BROWSERUSE_MODEL=${model}`,
      "-e",
      "BROWSERUSE_MAX_STEPS=10",
      "-e",
      `BROWSERUSE_PRICE_IN=${PRICE_IN}`,
      "-e",
      `BROWSERUSE_PRICE_OUT=${PRICE_OUT}`,
      IMAGE,
    ],
    { stdio: "ignore" },
  );
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    try {
      healthy = (await fetch(`${FRONT}/health`)).status === 200;
    } catch {}
  }
  if (!healthy) throw new Error(`front-door health timeout (model=${model})`);

  const backend = makeBackend(version);
  const results = [];
  for (const c of DATASET) {
    let r;
    try {
      r = await backend.dispatch({
        tenant: "default",
        harness: { id: "browseruse", version },
        evalCase: { ...c, timeoutSec: 300, tags: ["browser-use", "scorecard"] },
      });
    } catch (e) {
      console.log(`  ${c.id}: dispatch error ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const sc = (id) => r.scores.find((s) => s.graderId === id);
    const pass = sc("url-matches")?.pass === true && sc("dom-contains")?.pass === true;
    const usd = r.scores.find((s) => s.metric === "usd")?.value ?? 0;
    const steps = r.scores.find((s) => s.metric === "tool_calls")?.value ?? 0;
    console.log(
      `  ${c.id}: ${pass ? "PASS" : "FAIL"} url=${r.snapshot.url} steps=${steps} cost=$${Number(usd).toFixed(6)}`,
    );
    results.push(r);
  }
  cleanup();
  return { suiteId: "browseruse-suite", harness: `browseruse@${version}`, results };
}

function printSummary(sc) {
  console.log(`\n[${sc.harness}] 요약:`);
  for (const m of summarizeScorecard(sc)) {
    const pr = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
    console.log(`  ${m.metric}: n=${m.count} mean=${m.mean.toFixed(6)}${pr}`);
  }
}

let ok = false;
try {
  const A = await runModel("gpt-5.4-mini", "mini");
  const B = await runModel("chatgpt/gpt-5.4", "gpt5.4");
  printSummary(A);
  printSummary(B);

  const diff = diffScorecards(A, B);
  console.log(`\n=== diffScorecards(${diff.baseline} → ${diff.candidate}) ===`);
  console.log("메트릭 delta:");
  for (const m of diff.metrics) {
    console.log(
      `  ${m.metric}: ${m.baselineMean.toFixed(6)} → ${m.candidateMean.toFixed(6)} (Δ ${m.delta.toFixed(6)})`,
    );
  }
  console.log(`개선(fixed): ${JSON.stringify(diff.improvements.map((d) => `${d.caseId}/${d.metric}`))}`);
  console.log(`회귀(broke): ${JSON.stringify(diff.regressions.map((d) => `${d.caseId}/${d.metric}`))}`);

  const passRate = (sc) => {
    const m = summarizeScorecard(sc).find((x) => x.metric === "url_matches");
    return m?.passRate ?? 0;
  };
  ok = A.results.length === DATASET.length && B.results.length === DATASET.length;
  console.log(
    ok
      ? `\n✅ ①: browser-use 하니스로 ${DATASET.length}-케이스 데이터셋을 두 모델(mini/gpt-5.4)로 돌려 Scorecard 2개 생성 — ` +
          `summarizeScorecard 로 메트릭별 통과율/평균 cost·steps 집계(mini url_matches passRate=${(passRate(A) * 100).toFixed(0)}%, ` +
          `gpt-5.4=${(passRate(B) * 100).toFixed(0)}%), diffScorecards 로 A/B(메트릭 delta + pass 전이) 비교. 실 browser-use 로 컨트롤플레인 스코어카드 경로 실증.`
      : "\n⚠️ 일부 케이스 dispatch 실패(위 로그 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
