// Live e2e (service-topology): standard web benchmark (WebVoyager) adapter → dataset → real browser-use harness → scorecard.
// importWebVoyager(@everdict/datasets) maps WebVoyager-format jsonl (web_name/ques/web/answer) to browser cases
// (task=ques, env=browser{startUrl:web}, graders=[answer-match{answer}, steps, judge]). Here we run that dataset through the
// real browser-use front-door → CaseResult[] → Scorecard → summarizeScorecard (answer-match pass rate + mean steps/cost).
// Scoring = answer-match (the server emits the final answer as a trace message span → answer-match reads the answer from the trace) + steps.
// (Official WebVoyager uses a GPT-4V judge — everdict's adapter also includes a judge grader, but this live demo uses deterministic answer-match.)
//
// Prereqs: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; Jaeger(:4318/:16686).
// Key: OPENAI_API_KEY env or infra/litellm/.env(LITELLM_MASTER_KEY) — runtime only, never committed.
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
const MODEL = process.env.BROWSERUSE_MODEL ?? "chatgpt/gpt-5.4"; // real sites → stronger model
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
  console.error("No LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}
const cleanup = () => spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });

// WebVoyager-format sample → Dataset via the adapter (browser cases + answer-match/steps/judge).
const jsonl = readFileSync(new URL("../../examples/benchmarks/webvoyager-sample.jsonl", import.meta.url), "utf8");
const dataset = importWebVoyager(jsonl, {
  id: "webvoyager-sample",
  version: "v1",
  source: "github:MinorJerry/WebVoyager",
});
console.log(`=== WebVoyager adapter → Dataset: ${dataset.cases.length} cases ===`);
for (const c of dataset.cases) {
  console.log(
    `  ${c.id}: task="${c.task.slice(0, 60)}..." startUrl=${c.env.startUrl ?? "-"} graders=[${c.graders.map((g) => g.id).join(",")}]`,
  );
}

cleanup();
console.log(`\n=== start real browser-use front-door (model=${MODEL}) ===`);
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
    // Live demo uses deterministic scoring: drop judge (needs injection) from the adapter graders, keep only answer-match + steps.
    const graders = c.graders.filter((g) => g.id !== "judge");
    // Prepend the startUrl to the task so browser-use navigates there (the backend does not pass env.startUrl to the front-door).
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
  console.log("\n=== Scorecard summary (summarizeScorecard) ===");
  for (const m of summarizeScorecard(sc)) {
    const pr = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
    console.log(`  ${m.metric}: n=${m.count} mean=${m.mean.toFixed(6)}${pr}`);
  }
  const amSummary = summarizeScorecard(sc).find((m) => m.metric === "answer_match");
  ok = results.length === dataset.cases.length && (amSummary?.passRate ?? 0) > 0;
  console.log(
    ok
      ? `\n✅ ③: mapped the standard web benchmark format to a Dataset via the WebVoyager adapter (importWebVoyager) → ran ${dataset.cases.length} cases through the real browser-use harness to produce a Scorecard, answer-match pass rate ${((amSummary?.passRate ?? 0) * 100).toFixed(0)}% + mean steps/cost. WebVoyager (web) benchmark live via browser-use, following OSWorld (desktop).`
      : "\n⚠️ mismatch vs expected (some cases failed — see logs/model above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done");
}
process.exit(ok ? 0 : 1);
