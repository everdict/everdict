// Live e2e (service-topology): drive real browser-use multi-step against an *external real site* — measure success rate + real cost (USD).
// ②: not the container's own form but https://en.wikipedia.org — search→open article. Run N iterations with a stronger model
//    (chatgpt/gpt-5.4) to measure the pass rate (url-matches+dom-contains). A real internet site drives the model much harder.
// ③: the front-door computes USD by multiplying real token usage (TokenCost) by a unit price (LiteLLM /model/info → operator env
//    BROWSERUSE_PRICE_*) → emits it as OTLP llm_call.cost.usd → the cost grader sums the real USD. (A proxy model has a LiteLLM
//    price of 0, so an operator-specified *reference price* is supplied via env — same as the real cost method. Tokens are real, the unit price is operator input, USD is real arithmetic.)
//
// Prereq: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; start Jaeger (:4318/:16686).
// Key: OPENAI_API_KEY env or infra/litellm/.env (LITELLM_MASTER_KEY) — runtime only, never committed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const IMAGE = process.env.BROWSERUSE_IMAGE ?? "everdict-browseruse:demo";
const PORT = process.env.BROWSERUSE_PORT ?? "18080";
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4"; // stronger model
const MAX_STEPS = process.env.BROWSERUSE_MAX_STEPS ?? "10"; // more step headroom for a real site
const RUNS = Number(process.env.RUNS ?? "3");
const JAEGER_QUERY = process.env.JAEGER_QUERY ?? "http://localhost:16686";
// Operator-specified reference price ($/token) — used when LiteLLM has no price set. Default is a public mini-tier reference price (IN $0.15/1M, OUT $0.60/1M).
const PRICE_IN = process.env.BROWSERUSE_PRICE_IN ?? "0.00000015";
const PRICE_OUT = process.env.BROWSERUSE_PRICE_OUT ?? "0.0000006";
const NAME = "everdict-bu-realsite";
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
  console.error("no LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}
const cleanup = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });

cleanup();
console.log(`=== start the real browser-use front-door (docker, --network=host, model=${MODEL}) ===`);
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
  process.stdout.write("waiting for health");
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

  console.log(`\n=== external real site (Wikipedia) ×${RUNS} — measure success rate + real cost ===`);
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

  console.log("\n--- summary ---");
  console.table(rows);
  const rate = ((passes / RUNS) * 100).toFixed(0);
  console.log(`success rate: ${passes}/${RUNS} (${rate}%) | model=${MODEL}`);
  console.log(
    `cost: real tokens × unit price (LiteLLM /model/info or operator reference price IN=${PRICE_IN}/OUT=${PRICE_OUT} $/token) = real USD. A proxy model has a LiteLLM price of 0, so the operator reference price is used (tokens are real, USD is real arithmetic).`,
  );
  console.log(
    passes > 0
      ? "\n✅ ②③: real browser-use drove an external real site (Wikipedia) multi-step (search→article) — the backend grades " +
          "pass/fail deterministically to compute the success rate, and simultaneously pulls USD (real token usage × unit price) from the trace so the cost grader sums the real values."
      : "\n⚠️ all failed — check the run logs/model above",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(passes > 0 ? 0 : 1);
