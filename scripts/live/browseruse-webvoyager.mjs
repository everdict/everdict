// 라이브 e2e (service-topology): 표준 web 벤치마크(WebVoyager) 어댑터 → 데이터셋 → 실 browser-use 하니스 → 스코어카드.
// importWebVoyager(@everdict/datasets) 가 WebVoyager 형식 jsonl(web_name/ques/web/answer)을 browser 케이스로 매핑
// (task=ques, env=browser{startUrl:web}, graders=[answer-match{answer}, steps, judge]). 여기선 그 데이터셋을 실
// browser-use front-door 로 돌려 CaseResult[] → Scorecard → summarizeScorecard(정답대조 통과율 + 평균 steps/cost).
// 채점=answer-match(서버가 최종 답을 trace message 스팬으로 배출 → answer-match 가 trace 의 답을 본다) + steps.
// (공식 WebVoyager 는 GPT-4V judge — everdict 어댑터도 judge 그레이더를 포함하나, 라이브 데모는 결정론적 answer-match 사용.)
//
// 사전: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4"; // 실사이트 → 강한 모델
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const NAME = "everdict-bu-webvoyager";
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

// WebVoyager 형식 샘플 → 어댑터로 Dataset(browser 케이스 + answer-match/steps/judge).
const jsonl = readFileSync(new URL("../../examples/benchmarks/webvoyager-sample.jsonl", import.meta.url), "utf8");
const dataset = importWebVoyager(jsonl, {
  id: "webvoyager-sample",
  version: "v1",
  source: "github:MinorJerry/WebVoyager",
});
console.log(`=== WebVoyager 어댑터 → Dataset: ${dataset.cases.length} 케이스 ===`);
for (const c of dataset.cases) {
  console.log(
    `  ${c.id}: task="${c.task.slice(0, 60)}..." startUrl=${c.env.startUrl ?? "-"} graders=[${c.graders.map((g) => g.id).join(",")}]`,
  );
}

cleanup();
console.log(`\n=== 실 browser-use front-door 기동 (model=${MODEL}) ===`);
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
    "BROWSERUSE_MAX_STEPS=12",
    "-e",
    "BROWSERUSE_PRICE_IN=0.00000015",
    "-e",
    "BROWSERUSE_PRICE_OUT=0.0000006",
    IMAGE,
  ],
  { stdio: "ignore" },
);

let ok = false;
try {
  let healthy = false;
  process.stdout.write("health 대기");
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
    version: "webvoyager",
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

  const results = [];
  for (const c of dataset.cases) {
    // 라이브 데모는 결정론적 채점: 어댑터 graders 에서 judge(주입 필요) 를 빼고 answer-match + steps 만.
    const graders = c.graders.filter((g) => g.id !== "judge");
    // browser-use 가 startUrl 로 가도록 태스크 앞에 명시(env.startUrl 은 백엔드가 front-door 로 안 넘김).
    const task = c.env.startUrl ? `Go to ${c.env.startUrl} . ${c.task}` : c.task;
    let r;
    try {
      r = await backend.dispatch({
        tenant: "default",
        harness: { id: "browseruse", version: "webvoyager" },
        evalCase: { ...c, task, graders, timeoutSec: 300 },
      });
    } catch (e) {
      console.log(`  ${c.id}: dispatch error ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const am = r.scores.find((s) => s.metric === "answer_match");
    const steps = r.scores.find((s) => s.metric === "tool_calls")?.value ?? 0;
    const obs = await (await fetch(`${FRONT}/observe`)).json().catch(() => ({}));
    console.log(
      `  ${c.id}: answer_match=${am?.pass ? "PASS" : "FAIL"} steps=${steps} url=${r.snapshot.url} answer="${String(obs.result || "").slice(0, 70)}"`,
    );
    results.push(r);
  }

  const sc = { suiteId: "webvoyager-sample", harness: "browseruse@webvoyager", results };
  console.log("\n=== Scorecard 요약 (summarizeScorecard) ===");
  for (const m of summarizeScorecard(sc)) {
    const pr = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
    console.log(`  ${m.metric}: n=${m.count} mean=${m.mean.toFixed(6)}${pr}`);
  }
  const amSummary = summarizeScorecard(sc).find((m) => m.metric === "answer_match");
  ok = results.length === dataset.cases.length && (amSummary?.passRate ?? 0) > 0;
  console.log(
    ok
      ? `\n✅ ③: WebVoyager 어댑터(importWebVoyager)로 표준 web 벤치마크 형식을 Dataset 으로 매핑 → 실 browser-use 하니스로 ${dataset.cases.length} 케이스를 돌려 Scorecard 생성, answer-match(정답대조) 통과율 ${((amSummary?.passRate ?? 0) * 100).toFixed(0)}% + 평균 steps/cost 집계. OSWorld(데스크탑)에 이은 WebVoyager(웹) 벤치마크를 browser-use 로 라이브.`
      : "\n⚠️ 기대와 불일치(일부 케이스 실패 — 위 로그/모델 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
