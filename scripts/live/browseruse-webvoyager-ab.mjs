// 라이브 e2e: 실 WebVoyager 를 더 큰 N(다양한 사이트)으로 + 모델 A/B(gpt-5.4-mini vs chatgpt/gpt-5.4) judge 스코어카드.
// 같은 태스크 집합(같은 caseId)을 두 모델(=두 하니스 버전)로 돌려 → 모델별 Scorecard + summarizeScorecard(judge 통과율)
// + **사이트별 통과율 분해**(WebVoyager web_name 태그) + diffScorecards(모델 A/B: pass 전이 회귀/개선 + 메트릭 delta).
// 채점=LiteLLM text judge(WEBVOYAGER_RUBRIC; VLM 은 JUDGE_VISION 으로 별도 검증). 실 사이트라 통과율=난이도 반영.
//
// 사전: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { diffScorecards, summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const JUDGE_MODEL = process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const WV_N = Number(process.env.WV_N ?? "6");
const BENIGN = (process.env.WV_SITES ?? "ArXiv,Cambridge Dictionary,Wolfram Alpha,BBC News,GitHub,Huggingface").split(
  ",",
);
const NAME = "everdict-bu-ab";
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
  console.error("LLM 키 없음.");
  process.exit(2);
}
process.env.EVERDICT_JUDGE_MODEL = JUDGE_MODEL;
process.env.EVERDICT_JUDGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
const cleanup = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
const WV_RUBRIC =
  "You are evaluating a web-browsing agent on a WebVoyager task. Given the task instruction, the agent's " +
  "trajectory (trace) and the final page text (dom), decide PASS only if the task goal was clearly and " +
  "correctly accomplished; otherwise FAIL. Be strict and judge from the evidence, not assumptions.";

async function buildDataset() {
  const res = await fetch("https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl");
  const rows = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const bySite = new Map();
  for (const r of rows) {
    if (!BENIGN.includes(r.web_name)) continue;
    if (!bySite.has(r.web_name)) bySite.set(r.web_name, []);
    bySite.get(r.web_name).push(r);
  }
  const picked = [];
  const sites = [...bySite.keys()];
  for (let i = 0; picked.length < WV_N && i < 100; i++) {
    const arr = bySite.get(sites[i % sites.length]);
    if (arr?.length) picked.push(arr.shift());
    if (sites.every((s) => (bySite.get(s) ?? []).length === 0)) break;
  }
  return importWebVoyager(picked.map((r) => JSON.stringify(r)).join("\n"), {
    id: "webvoyager-real",
    version: "main",
    source: "github:MinorJerry/WebVoyager",
  });
}

function makeBackend() {
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
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    specFor: () => ({
      kind: "service",
      id: "browseruse",
      version: "ab",
      services: [{ name: "agent", image: IMAGE, port: Number(PORT), needs: [], perRun: [], replicas: 1 }],
      dependencies: [],
      frontDoor: { service: "agent", submit: "POST /runs" },
      traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
    }),
    newRunId: () => randomUUID().replace(/-/g, ""),
  });
}

async function runModel(model, version, cases) {
  cleanup();
  console.log(`\n### browseruse@${version} (model=${model}) — ${cases.length} 케이스 ###`);
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
      "BROWSERUSE_MAX_STEPS=12",
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
  if (!healthy) throw new Error(`health timeout (${model})`);
  const backend = makeBackend();
  const results = [];
  for (const c of cases) {
    const task = c.env.startUrl ? `Go to ${c.env.startUrl} . ${c.task}` : c.task;
    const graders = [...c.graders.filter((g) => g.id !== "judge"), { id: "judge", config: { rubric: WV_RUBRIC } }];
    try {
      const r = await backend.dispatch({
        tenant: "default",
        harness: { id: "browseruse", version },
        evalCase: { ...c, task, graders, timeoutSec: 300 },
      });
      const j = r.scores.find((s) => s.metric === "judge");
      console.log(`  ${c.id} [${(c.tags || []).join(",")}]: judge=${j?.pass ? "PASS" : "FAIL"}`);
      results.push({ ...r, _site: (c.tags || [])[0] || "?" });
    } catch (e) {
      console.log(`  ${c.id}: error ${e instanceof Error ? e.message : e}`);
    }
  }
  cleanup();
  return { suiteId: "webvoyager-real", harness: `browseruse@${version}`, results };
}

function perSite(sc) {
  const m = new Map();
  for (const r of sc.results) {
    const site = r._site;
    const j = r.scores.find((s) => s.metric === "judge");
    const e = m.get(site) ?? { pass: 0, total: 0 };
    e.total++;
    if (j?.pass) e.pass++;
    m.set(site, e);
  }
  return m;
}

let ok = false;
try {
  const dataset = await buildDataset();
  console.log(`=== WebVoyager(real) A/B — ${dataset.cases.length} 케이스 × {mini, gpt-5.4} | judge=${JUDGE_MODEL} ===`);
  const A = await runModel("gpt-5.4-mini", "mini", dataset.cases);
  const B = await runModel("chatgpt/gpt-5.4", "gpt5.4", dataset.cases);

  for (const sc of [A, B]) {
    const j = summarizeScorecard(sc).find((m) => m.metric === "judge");
    console.log(`\n[${sc.harness}] judge passRate=${((j?.passRate ?? 0) * 100) | 0}% (n=${j?.count ?? 0})`);
    console.log("  사이트별:");
    for (const [site, e] of perSite(sc)) console.log(`    ${site}: ${e.pass}/${e.total}`);
  }

  const diff = diffScorecards(A, B);
  console.log(`\n=== diffScorecards(${diff.baseline} → ${diff.candidate}) ===`);
  for (const m of diff.metrics)
    console.log(
      `  ${m.metric}: ${m.baselineMean.toFixed(3)} → ${m.candidateMean.toFixed(3)} (Δ ${m.delta.toFixed(3)})`,
    );
  console.log(`  개선(fixed): ${JSON.stringify(diff.improvements.map((d) => d.caseId))}`);
  console.log(`  회귀(broke): ${JSON.stringify(diff.regressions.map((d) => d.caseId))}`);

  ok = A.results.length > 0 && B.results.length > 0;
  console.log(
    ok
      ? `\n✅ ②: 실 WebVoyager ${dataset.cases.length}태스크(다양한 사이트)를 두 모델로 judge 채점 → 모델별 Scorecard + 사이트별 통과율 분해 + diffScorecards 로 mini vs gpt-5.4 A/B(pass 전이 + 메트릭 delta). 본격 벤치마크 규모의 스코어카드 파이프라인.`
      : "\n⚠️ 결과 부족",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
