// Live e2e (service-topology): WebVoyager the *official way (judge-scored)* — browser-use harness + LiteLLM judge.
// Official WebVoyager has GPT-4V judge the trajectory (no answer field). everdict's webvoyager adapter also includes a judge
// grader → here we enable EVERDICT_JUDGE_MODEL (LiteLLM) so makeGradersFromEnv builds a JudgeGrader (judging trace+dom by
// WEBVOYAGER_RUBRIC), and the judge scores browser-use's run of the real site as pass/fail + reason.
//   WV_SOURCE=sample  → examples/benchmarks/webvoyager-sample.jsonl (has answers → judge + answer-match comparison) [②]
//   WV_SOURCE=real    → download github WebVoyager_data.jsonl, sample WV_N tasks from benign sites (no answers → judge only) [③]
//
// Prereqs: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
// Key: OPENAI_API_KEY env or infra/litellm/.env(LITELLM_MASTER_KEY) — runtime only, never committed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { summarizeScorecard } from "../../packages/domain/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4";
const JUDGE_MODEL = process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini";
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
const WV_SOURCE = process.env.WV_SOURCE ?? "sample";
const WV_N = Number(process.env.WV_N ?? "6");
const JUDGE_VISION = process.env.JUDGE_VISION === "1"; // when on: use_vision + final screenshot base64 → VLM judge (official GPT-4V way)
const RESTRICT = process.env.RESTRICT_DOMAIN === "1"; // when on: restrict the agent to the task site's domain (prevents detours via Bing etc.)
// Curated to *information-seeking* sites with few CAPTCHA/human-verification/login walls — so pass rate reflects agent
// capability, not anti-bot. Set calibrated from live observation:
//   Included (reachable; failure is an agent-capability issue): ArXiv·BBC News·Cambridge Dictionary·Coursera·ESPN·GitHub·Wolfram Alpha.
//   Excluded (confirmed anti-bot/verification): Huggingface (human-verification), Allrecipes (access/verification — confirmed
//     in an 8-site run), Amazon/Booking (CAPTCHA·login), Google Flights/Map/Search (consent·CAPTCHA), Apple. Overridable via WV_SITES.
const BENIGN = (process.env.WV_SITES ?? "ArXiv,BBC News,Cambridge Dictionary,Coursera,ESPN,GitHub,Wolfram Alpha").split(
  ",",
);
const NAME = "everdict-bu-wvjudge";
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
  console.error("No LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}
// Enable the judge — the backend's makeGradersFromEnv → judgeFromEnv(process.env) builds a JudgeGrader(LiteLLM) from this env.
process.env.EVERDICT_JUDGE_MODEL = JUDGE_MODEL;
process.env.EVERDICT_JUDGE_PROVIDER = "openai";
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
    // Round-robin one per benign site for diversity, up to WV_N.
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
console.log(`=== WebVoyager(${WV_SOURCE}) → ${dataset.cases.length} cases | judge=${JUDGE_MODEL} agent=${MODEL} ===`);

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
  process.stdout.write("waiting for health");
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

  // Official WebVoyager judge rubric (trajectory-based success verdict). importWebVoyager maps only [answer-match, steps], so
  // we add the judge grader explicitly (same intent as the catalog adapter's WEBVOYAGER judge) → actual verdict via judge env.
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
      // With judge env on, makeGradersFromEnv builds a JudgeGrader(LiteLLM) → judges trace+dom by the rubric.
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
  console.log("\n=== Scorecard summary (judge-scored) ===");
  for (const m of summarizeScorecard(sc)) {
    const pr = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
    console.log(`  ${m.metric}: n=${m.count} mean=${m.mean.toFixed(4)}${pr}`);
  }
  if (failures.length) {
    console.log("\n=== failure analysis ===");
    for (const f of failures) console.log(`  ${f.id}${f.url ? ` (${f.url})` : ""}: ${f.reason}`);
  }
  const judgeSummary = summarizeScorecard(sc).find((m) => m.metric === "judge");
  ok = results.length > 0 && judgeSummary !== undefined; // did the judge actually score (pass rate itself depends on task difficulty)
  console.log(
    ok
      ? `\n✅ ${WV_SOURCE === "sample" ? "②" : "③"}: scored WebVoyager(${WV_SOURCE}, ${results.length} cases) the official way (LiteLLM judge=${JUDGE_MODEL}, ` +
          `judging trace+dom by WEBVOYAGER_RUBRIC) — judge passRate=${((judgeSummary?.passRate ?? 0) * 100).toFixed(0)}%` +
          `${WV_SOURCE === "real" ? " (real sites, no answers → judge only; failures analyzed above)" : " + answer-match comparison"}. The judge evaluates the trajectory browser-use produced on the real site.`
      : "\n⚠️ judge did not score (check EVERDICT_JUDGE_MODEL/key)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
