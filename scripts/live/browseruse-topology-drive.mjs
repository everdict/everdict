// Live e2e (service-topology): drive *real browser-use* as everdict's ServiceTopologyBackend front-door — local docker runtime.
// (Orchestrator deploy is already verified with kind+Nomad; for the K8s deploy version see browseruse-topology-k8s.mjs.)
// What this closes:
//  ② interactive multi-step task — not static example.com but /form served directly by the container: navigate→input→click→
//     verify result. Deterministic scoring via url-matches(q=everdict) + dom-contains(Results for everdict).
//  ③ real trace — per run the front-door emits *actual* token usage (TokenCost) + action list (action_names) to Jaeger(:4318) over OTLP,
//     and the backend's traceSource (OtelTraceSource, Jaeger query :16686) pulls it by the same trace_id to score steps/cost.
//     trace_id matching: override newRunId to 32-hex → thread_id="run-<32hex>" → front-door uses that hex as the trace_id.
//
// Prereqs: docker build -t everdict-browseruse:demo -f scripts/live/Dockerfile.browseruse scripts/live ; start Jaeger(:4318/:16686).
// Key: OPENAI_API_KEY env or infra/litellm/.env(LITELLM_MASTER_KEY) — runtime only, never committed.
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
  console.error("No LLM key (OPENAI_API_KEY or infra/litellm/.env).");
  process.exit(2);
}

function cleanup() {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}

cleanup();
console.log("=== start real browser-use front-door (docker, --network=host) ===");
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
  process.stdout.write("waiting for health");
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    process.stdout.write(".");
    try {
      const r = await fetch(`${FRONT}/health`);
      healthy = r.status === 200;
    } catch {}
  }
  console.log(healthy ? " up" : " (no health response)");
  if (!healthy) throw new Error("front-door health timeout");

  // Real ServiceTopologyBackend — runtime is the local docker front-door, traceSource is real Jaeger (OtelTraceSource, retry on ingest lag).
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
    newRunId: () => randomUUID().replace(/-/g, ""), // 32-hex → matched as Jaeger trace_id
  });

  const job = {
    tenant: "default",
    harness: { id: "browseruse", version: "1.0.0" },
    evalCase: {
      id: "search-form",
      env: { kind: "browser", url: `${FRONT}/form` },
      task: `Go to ${FRONT}/form , type "everdict eval" into the search input box, then click the Search button. After the results page loads, report the page heading.`,
      graders: [
        { id: "url-matches", config: { pattern: "[?&]q=everdict" } }, // submitted result URL
        { id: "dom-contains", config: { text: "Results for everdict" } }, // result page text
        { id: "steps", config: {} }, // trace-based: real browser-use action count
        { id: "cost", config: {} }, // trace-based: real token usage (usd is 0 — proxy model price unknown)
      ],
      timeoutSec: 300,
      tags: ["browser-use", "service-topology", "interactive", "trace"],
    },
  };

  console.log(
    "\n=== ServiceTopologyBackend.dispatch — drive real browser-use interactively + score from real trace ===",
  );
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
  console.log("snapshot.dom(first 100):", String(result.snapshot.dom).slice(0, 100).replace(/\s+/g, " "));
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
  const stepsOk = (score("steps")?.value ?? 0) > 0; // did real actions land in the trace
  const tracePulled = llmCalls.length > 0 && toolCalls.length > 0; // real trace pulled from Jaeger
  ok = result.snapshot.kind === "browser" && urlOk && domOk && stepsOk && tracePulled;
  console.log(
    ok
      ? "\n✅ ②+③: real browser-use, acting as the ServiceTopologyBackend front-door, drove the interactive form multi-step " +
          "(navigate→input→click) to reach the result page (url-matches q=everdict + dom-contains 'Results for everdict' PASS), while " +
          "emitting the run's actual token usage / action list to Jaeger over OTLP → the backend pulled the same trace_id via OtelTraceSource " +
          "to score steps (real action count) / cost. Beyond a static demo — interactive driving + real trace pull, all through the backend path."
      : "\n⚠️ mismatch vs expected (see actions/tokens/trace/scores above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  cleanup();
  console.log("cleanup done (front-door container removed)");
}
process.exit(ok ? 0 : 1);
