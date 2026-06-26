// 라이브 e2e (service-topology): WebVoyager 를 *공식 방식(judge 채점)*으로 — browser-use 하니스 + LiteLLM judge.
// 공식 WebVoyager 는 GPT-4V 가 트라젝토리를 판정한다(정답 필드 없음). assay 의 webvoyager 어댑터도 judge 그레이더를
// 포함 → 여기선 ASSAY_JUDGE_MODEL(LiteLLM) 을 켜서 makeGradersFromEnv 가 JudgeGrader 를 빌드하게 하고(trace+dom 을
// WEBVOYAGER_RUBRIC 로 판정), browser-use 가 실 사이트를 구동한 결과를 judge 가 pass/fail + 사유로 채점한다.
//   WV_SOURCE=sample  → examples/benchmarks/webvoyager-sample.jsonl (정답 있음 → judge + answer-match 비교) [②]
//   WV_SOURCE=real    → github WebVoyager_data.jsonl 다운로드, benign 사이트에서 WV_N 개 샘플(정답 없음 → judge 만) [③]
//
// 사전: docker build -t assay-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
// 키: OPENAI_API_KEY env 또는 infra/litellm/.env(LITELLM_MASTER_KEY) — 런타임에만, 커밋 안 함.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "assay-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4";
const JUDGE_MODEL = process.env.ASSAY_JUDGE_MODEL ?? "gpt-5.4-mini";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const WV_SOURCE = process.env.WV_SOURCE ?? "sample";
const WV_N = Number(process.env.WV_N ?? "6");
const JUDGE_VISION = process.env.JUDGE_VISION === "1"; // 켜면 use_vision + 최종 스크린샷 base64 → VLM judge(공식 GPT-4V 방식)
const RESTRICT = process.env.RESTRICT_DOMAIN === "1"; // 켜면 에이전트를 태스크 사이트 도메인으로 제한(Bing 등 우회 방지)
// CAPTCHA/human-verification/로그인 벽이 적은 *정보탐색형* 사이트로 큐레이션 — 통과율을 anti-bot 이 아니라 에이전트
// 능력에 귀속시키기 위해. 라이브 관측으로 보정한 집합:
//   포함(도달 가능, 실패해도 에이전트 능력 문제): ArXiv·BBC News·Cambridge Dictionary·Coursera·ESPN·GitHub·Wolfram Alpha.
//   제외(anti-bot/verification 확인): Huggingface(human-verification), Allrecipes(access/verification — 8사이트 런에서
//     확인), Amazon/Booking(CAPTCHA·로그인), Google Flights/Map/Search(동의·CAPTCHA), Apple. WV_SITES 로 오버라이드 가능.
const BENIGN = (process.env.WV_SITES ?? "ArXiv,BBC News,Cambridge Dictionary,Coursera,ESPN,GitHub,Wolfram Alpha").split(
  ",",
);
const NAME = "assay-bu-wvjudge";
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
// judge 활성화 — 백엔드의 makeGradersFromEnv → judgeFromEnv(process.env) 가 이 env 로 JudgeGrader(LiteLLM) 빌드.
process.env.ASSAY_JUDGE_MODEL = JUDGE_MODEL;
process.env.ASSAY_JUDGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
const cleanup = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });

async function buildDataset() {
  if (WV_SOURCE === "real") {
    const res = await fetch("https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl");
    const text = await res.text();
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // benign 사이트별로 1개씩 라운드로빈해 다양성 확보, WV_N 까지.
    const bySite = new Map();
    for (const r of rows) {
      if (!BENIGN.includes(r.web_name)) continue;
      if (!bySite.has(r.web_name)) bySite.set(r.web_name, []);
      bySite.get(r.web_name).push(r);
    }
    const picked = [];
    const sites = [...bySite.keys()];
    for (let i = 0; picked.length < WV_N && i < 50; i++) {
      const site = sites[i % sites.length];
      const arr = bySite.get(site);
      if (arr?.length) picked.push(arr.shift());
      if (sites.every((s) => (bySite.get(s) ?? []).length === 0)) break;
    }
    const jsonl = picked.map((r) => JSON.stringify(r)).join("\n");
    return importWebVoyager(jsonl, { id: "webvoyager-real", version: "main", source: "github:MinorJerry/WebVoyager" });
  }
  const jsonl = readFileSync(new URL("../../examples/benchmarks/webvoyager-sample.jsonl", import.meta.url), "utf8");
  return importWebVoyager(jsonl, { id: "webvoyager-sample", version: "v1", source: "github:MinorJerry/WebVoyager" });
}

const dataset = await buildDataset();
console.log(`=== WebVoyager(${WV_SOURCE}) → ${dataset.cases.length} 케이스 | judge=${JUDGE_MODEL} agent=${MODEL} ===`);

cleanup();
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
    "-e",
    `BROWSERUSE_VISION=${JUDGE_VISION ? "1" : ""}`,
    "-e",
    `BROWSERUSE_RESTRICT_DOMAIN=${RESTRICT ? "1" : ""}`,
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
          return { kind: "browser", url: j.url || "", dom: j.dom || "", screenshot: j.screenshot || "", console: [] };
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

  // 공식 WebVoyager judge 루브릭(트라젝토리 기반 성공 판정). importWebVoyager 는 [answer-match, steps] 만 매핑하므로
  // judge 그레이더를 명시적으로 추가(catalog 어댑터의 WEBVOYAGER judge 와 동일 취지) → judge env 로 실제 판정.
  const WV_RUBRIC =
    "You are evaluating a web-browsing agent on a WebVoyager task. Given the task instruction, the agent's " +
    "trajectory (trace: actions taken + final answer message) and the final page text (dom), decide PASS only if " +
    "the task goal was clearly and correctly accomplished by the agent; otherwise FAIL. Be strict and judge from " +
    "the evidence in the trace/page, not assumptions.";
  const results = [];
  const failures = [];
  for (const c of dataset.cases) {
    const task = c.env.startUrl ? `Go to ${c.env.startUrl} . ${c.task}` : c.task;
    const graders = [
      ...c.graders.filter((g) => g.id !== "judge"),
      { id: "judge", config: { rubric: WV_RUBRIC, useScreenshot: JUDGE_VISION } },
    ];
    let r;
    try {
      // judge env 가 켜져 makeGradersFromEnv 가 JudgeGrader(LiteLLM) 빌드 → trace+dom 을 루브릭으로 판정.
      r = await backend.dispatch({
        tenant: "default",
        harness: { id: "browseruse", version: "webvoyager" },
        evalCase: { ...c, task, graders, timeoutSec: 300 },
      });
    } catch (e) {
      console.log(`  ${c.id}: dispatch error ${e instanceof Error ? e.message : e}`);
      failures.push({ id: c.id, reason: `dispatch error: ${e instanceof Error ? e.message : e}` });
      continue;
    }
    const judge = r.scores.find((s) => s.metric === "judge");
    const am = r.scores.find((s) => s.metric === "answer_match");
    const steps = r.scores.find((s) => s.metric === "tool_calls")?.value ?? 0;
    const pass = judge?.pass === true;
    const shot = r.snapshot.screenshot ? `${Math.round(r.snapshot.screenshot.length / 1000)}KB` : "none";
    console.log(
      `  ${c.id}: judge=${pass ? "PASS" : "FAIL"}${am ? ` answer_match=${am.pass ? "P" : "F"}` : ""} steps=${steps} shot=${shot} url=${r.snapshot.url}`,
    );
    if (judge?.detail) console.log(`     judge: ${String(judge.detail).replace(/\s+/g, " ").slice(0, 160)}`);
    if (!pass)
      failures.push({
        id: c.id,
        url: r.snapshot.url,
        reason: String(judge?.detail || "no judge verdict").slice(0, 140),
      });
    results.push(r);
  }

  const sc = { suiteId: `webvoyager-${WV_SOURCE}`, harness: "browseruse@webvoyager", results };
  console.log("\n=== Scorecard 요약 (judge 채점) ===");
  for (const m of summarizeScorecard(sc)) {
    const pr = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
    console.log(`  ${m.metric}: n=${m.count} mean=${m.mean.toFixed(4)}${pr}`);
  }
  if (failures.length) {
    console.log("\n=== 실패 분석 ===");
    for (const f of failures) console.log(`  ${f.id}${f.url ? ` (${f.url})` : ""}: ${f.reason}`);
  }
  const judgeSummary = summarizeScorecard(sc).find((m) => m.metric === "judge");
  ok = results.length > 0 && judgeSummary !== undefined; // judge 가 실제로 채점했는가(통과율 자체는 태스크 난이도에 좌우)
  console.log(
    ok
      ? `\n✅ ${WV_SOURCE === "sample" ? "②" : "③"}: WebVoyager(${WV_SOURCE}, ${results.length}케이스)를 공식 방식(LiteLLM judge=${JUDGE_MODEL}, ` +
          `WEBVOYAGER_RUBRIC 로 trace+dom 판정)으로 채점 — judge passRate=${((judgeSummary?.passRate ?? 0) * 100).toFixed(0)}%` +
          `${WV_SOURCE === "real" ? " (실 사이트, 정답 없음 → judge 만; 실패는 위 분석)" : " + answer-match 비교"}. browser-use 가 실 사이트를 구동한 트라젝토리를 judge 가 평가.`
      : "\n⚠️ judge 미채점(ASSAY_JUDGE_MODEL/키 확인)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
