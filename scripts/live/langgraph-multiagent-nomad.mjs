// Live e2e: a REAL multi-agent app (planner ↔ executor LangGraph + web frontend + postgres + redis) deployed to real
// Nomad via NomadTopologyRuntime and evaluated by the REAL Everdict engine — ServiceTopologyBackend drives each task
// through the front door, and an LLM JudgeGrader (LiteLLM) scores the answer quality → a Scorecard with quality scores.
//
// This is the "real agent + judge → quality score" verification: not browser/infra, but an actual agent topology whose
// services exchange messages to perform tasks and use redis+postgres, judged end to end.
//
// Prereqs: nomad agent -dev (docker driver) + LiteLLM on the host (:4000). Build the images:
//   docker build -t everdict-lg-agent:1 examples/bundles/langgraph-multiagent/agent
//   docker build -t everdict-lg-web:1   examples/bundles/langgraph-multiagent/web
// Run:  node scripts/live/langgraph-multiagent-nomad.mjs
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NomadTopologyRuntime, ServiceTopologyBackend } from "../../packages/topology/dist/index.js";

const ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
// LLM key — env or infra/litellm/.env (LITELLM_MASTER_KEY). Never hardcode a secret here (full-history gitleaks).
function llmKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = llmKey();
if (!KEY) {
  console.error("No LLM key — set OPENAI_API_KEY or provide infra/litellm/.env (LITELLM_MASTER_KEY).");
  process.exit(2);
}
const MODEL = process.env.LG_MODEL ?? "gpt-5.4-mini";
const LITELLM_CONTAINER = "http://172.17.0.1:4000/v1"; // reachable from the Nomad alloc (docker gateway)
const LITELLM_HOST = "http://127.0.0.1:4000/v1"; // reachable from THIS control-plane process (the judge)
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape (ESC) strip for readable log output
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

// Judge config (read by makeGradersFromEnv → JudgeGrader(LiteLLM)) — this is what produces the quality score.
process.env.EVERDICT_JUDGE_MODEL = MODEL;
process.env.EVERDICT_JUDGE_PROVIDER = "openai";
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = LITELLM_HOST;

// The harness: a co-located topology — the LangGraph agent + a web frontend + postgres + redis, all on one netns so the
// agent reaches its stores over localhost (genuine postgres/redis use; the frontend talks to the agent).
const spec = {
  kind: "service",
  id: "langgraph-multiagent",
  version: "1.0.0",
  services: [
    // Stores: NO declared port → they run in the shared netns and bind their default ports internally (the agent
    // reaches them over localhost), but the runtime does NOT HTTP-probe them (they aren't HTTP servers).
    {
      name: "postgres",
      image: "postgres:16-alpine",
      needs: [],
      perRun: [],
      replicas: 1,
      env: { POSTGRES_USER: "everdict", POSTGRES_PASSWORD: "everdict", POSTGRES_DB: "everdict" },
    },
    { name: "redis", image: "redis:7-alpine", needs: [], perRun: [], replicas: 1, env: {} },
    {
      name: "agent",
      image: "everdict-lg-agent:1",
      port: 8000,
      needs: ["postgres", "redis"],
      perRun: ["thread_id"],
      replicas: 1,
      env: {
        DATABASE_URL: "postgresql://everdict:everdict@localhost:5432/everdict",
        REDIS_URL: "redis://localhost:6379",
        MODEL,
      },
    },
    {
      name: "web",
      image: "everdict-lg-web:1",
      port: 8080,
      needs: ["agent"],
      perRun: [],
      replicas: 1,
      wiring: [{ service: "agent", urlEnv: "AGENT_URL" }],
      env: {},
    },
  ],
  dependencies: [],
  // Sync front door: POST /runs {task, thread_id} returns the answer; no browser target → the response is the observation the judge scores.
  frontDoor: {
    service: "agent",
    submit: "POST /runs",
    completion: { mode: "sync" },
    request: { bodyTemplate: { task: "{{task}}", thread_id: "{{run_id}}" } },
  },
  traceSource: { kind: "otel", endpoint: "http://unused" },
};

const RUBRIC =
  "You are grading an AI agent's answer to a task. The agent's JSON response contains its final `output`. " +
  "Score 1.0 if the final answer is correct and complete, 0.5 if partially correct, 0.0 if wrong or missing. " +
  "Judge ONLY correctness of the answer to the task.";

const cases = [
  { id: "pct", task: "What is 15% of 240? Show the calculation.", note: "36" },
  { id: "primes", task: "List the prime numbers between 10 and 20.", note: "11,13,17,19" },
  { id: "reverse", task: "Reverse the word 'everdict' and give only the reversed string.", note: "tcidreve" },
];

const nomad = new NomadTopologyRuntime({
  addr: ADDR,
  readyTimeoutMs: 180000,
  pollIntervalMs: 2000,
  maxPolls: 120,
  // Injected into every service — the agent reads OPENAI_* for its LLM calls (LiteLLM via the docker gateway).
  storeEnv: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: LITELLM_CONTAINER },
});

// A no-op trace source — the quality signal here is the judged answer (snapshot), not a pulled trace.
const traceSource = {
  async fetch() {
    return [];
  },
};

async function main() {
  console.log(
    "\n\x1b[1mLangGraph multi-agent (planner↔executor + web + postgres + redis) — deploy to Nomad, judge quality\x1b[0m",
  );
  const backend = new ServiceTopologyBackend({
    runtime: nomad,
    traceSource,
    specFor: () => spec,
    newRunId: () => randomUUID().replace(/-/g, ""),
  });

  const results = [];
  try {
    for (const c of cases) {
      console.log(`\n▶ case "${c.id}": ${c.task}`);
      const job = {
        tenant: "default",
        harness: { id: spec.id, version: spec.version },
        evalCase: {
          id: c.id,
          env: { kind: "prompt" },
          task: c.task,
          graders: [{ id: "judge", config: { rubric: RUBRIC } }],
          timeoutSec: 240,
          tags: ["langgraph", "multi-agent", "service-topology", "nomad", "judge"],
        },
      };
      const r = await backend.dispatch(job);
      const judge = r.scores.find((s) => s.graderId === "judge");
      const answer = (() => {
        try {
          return JSON.parse(r.snapshot.output ?? "{}").output ?? "";
        } catch {
          return r.snapshot.output ?? "";
        }
      })();
      console.log(`   answer: ${strip(answer).slice(0, 120).replace(/\n/g, " ")}`);
      console.log(`   judge: value=${judge?.value} pass=${judge?.pass} — ${strip(judge?.detail ?? "").slice(0, 140)}`);
      results.push({ id: c.id, value: judge?.value ?? 0, pass: judge?.pass === true });
    }
  } finally {
    await nomad.teardown(spec).catch(() => {});
    console.log("\nteardown done");
  }

  // Scorecard summary — the quality score across the dataset.
  const n = results.length;
  const mean = n ? results.reduce((a, r) => a + r.value, 0) / n : 0;
  const passRate = n ? results.filter((r) => r.pass).length / n : 0;
  console.log("\n\x1b[1m=== SCORECARD (langgraph-multiagent × judge) ===\x1b[0m");
  for (const r of results) console.log(`  ${r.id.padEnd(8)} quality=${r.value.toFixed(2)} ${r.pass ? "PASS" : "fail"}`);
  console.log("  ----");
  console.log(`  mean quality=${mean.toFixed(3)} · passRate=${(passRate * 100).toFixed(0)}%  (${n} cases)`);
  const ok = n === cases.length && passRate >= 0.66;
  console.log(
    ok
      ? "\n\x1b[32m✅ Real multi-agent topology deployed to Nomad, driven by ServiceTopologyBackend, and judged by an LLM JudgeGrader → quality scorecard.\x1b[0m"
      : "\n\x1b[31m⚠️ low quality / incomplete — see per-case above\x1b[0m",
  );
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error("error:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
