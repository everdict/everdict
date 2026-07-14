// Live e2e: the WORKSPACE TRACE-SOURCE REGISTRY end to end against real MLflow 3.14.
//   register a dev-cluster observability endpoint by name → select it per-harness → a service-topology case runs and
//   everdict PULLS that case's trace from the registered source (auth + TAG correlation), then grades it.
// This exercises the new path (TraceSourceService.resolve → ServiceTopologyBackend.traceSourceFor), not the command
// harness (trace-collect-mlflow.mjs already covers that). It proves the registry actually drives the pull.
//
//   A) selection → pull: a source registered + assigned to the harness → the dispatch pulls the tagged trace and scores it.
//   B) no selection → fallback: a harness with NO assignment falls back to the fixed runtime source (dead here → 0 events).
//
// Prereq: docker (boots ghcr.io/mlflow/mlflow:v3.14.0, no auth, sqlite). Set MLFLOW_ENDPOINT to reuse a server.
// Usage: node scripts/live/trace-source-registry-mlflow.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { TraceSourceService } from "../../packages/application-control/dist/index.js";
import { InMemoryWorkspaceSettingsStore } from "../../packages/db/dist/index.js";
import { stepsGrader } from "../../packages/graders/dist/index.js";
import { costGrader } from "../../packages/graders/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-source-registry-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "";

const up = async (url) => {
  try {
    return (await fetch(`${url}/version`)).ok;
  } catch {
    return false;
  }
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:5508";
  console.log(`MLflow boot (docker, v3.14.0, no auth) → ${ENDPOINT}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "5508:5000",
    "ghcr.io/mlflow/mlflow:v3.14.0",
    "mlflow",
    "server",
    "--host",
    "0.0.0.0",
    "--port",
    "5000",
    "--backend-store-uri",
    "sqlite:////tmp/mlflow-tsr.db",
  ]);
  bootedDocker = true;
}
for (let i = 0; i < 60 && !(await up(ENDPOINT)); i++) await sleep(1000);
if (!(await up(ENDPOINT))) throw new Error(`MLflow did not come up: ${ENDPOINT}`);
console.log(`MLflow up: ${ENDPOINT} (version=${await (await fetch(`${ENDPOINT}/version`)).text()})`);

const api = async (path, init = {}) => {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

try {
  const WS = "acme";
  const HARNESS_ID = "svc-browser-agent";

  // 1) Seed a "trace written by the deployed agent" to the platform, then TAG it everdict.run_id (the real correlate=tag contract).
  const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name: `everdict-tsr-e2e-${Date.now()}` }),
  });
  const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, project: experimentId });
  const seedTrace = [
    { t: 0, kind: "message", role: "user", text: "search the portal and report the code" },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "browser.navigate", args: {} },
    { t: 30, kind: "tool_result", id: "t1", ok: true, output: "loaded" },
  ];
  const seeded = await sink.export({ scorecardId: "sc", dataset: "d@1", harness: `${HARNESS_ID}@1` }, [
    { caseId: "seed", trace: seedTrace, scores: [] },
  ]);
  if (seeded.cases[0]?.error) throw new Error(`seed failed: ${seeded.cases[0].error}`);
  const traceId = seeded.cases[0].externalId;
  const runId = `evd-tsr-${Date.now().toString(36)}`; // the id everdict mints/injects — the deployed agent leaves it as a TAG
  await api(`/api/3.0/mlflow/traces/${traceId}/tags`, {
    method: "PATCH",
    body: JSON.stringify({ key: "everdict.run_id", value: runId }),
  });
  console.log(`seeded trace ${traceId} tagged everdict.run_id=${runId} (experiment ${experimentId})`);
  // Poll until the spans are queryable (absorb upload lag).
  const probe = buildTraceSource({ kind: "mlflow", endpoint: ENDPOINT });
  for (let i = 0; i < 20; i++) {
    const ev = await probe.fetch(traceId).catch(() => []);
    if (ev.some((e) => e.kind === "llm_call")) break;
    await sleep(1000);
  }

  // 2) REGISTER the source in the workspace (by name) + ASSIGN it to the harness — the feature under test.
  const settings = new InMemoryWorkspaceSettingsStore();
  const sources = new TraceSourceService(settings, { secretsFor: async () => ({}) }); // OSS dev MLflow: no auth
  await sources.upsert(WS, {
    name: "dev-mlflow",
    kind: "mlflow",
    endpoint: ENDPOINT,
    correlate: "tag", // the deployed agent tagged its own trace with everdict.run_id
    project: String(experimentId), // MLflow tag search requires the experiment scope
  });
  await sources.assign(WS, HARNESS_ID, "dev-mlflow");
  console.log("registered source 'dev-mlflow' (correlate=tag) and assigned it to the harness");

  // 3) A minimal service-topology backend whose pull uses the harness's SELECTED workspace source (traceSourceFor).
  const spec = {
    kind: "service",
    id: HARNESS_ID,
    version: "1.0.0",
    services: [{ name: "agent", image: "agent:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [],
    frontDoor: { service: "agent", submit: "POST /run" },
    traceSource: { kind: "mlflow", endpoint: ENDPOINT },
  };
  const runtime = {
    id: "mock",
    async ensureTopology() {
      return { endpoints: { agent: "http://agent:8000" } };
    },
  };
  // The fixed fallback source points at a DEAD endpoint, so any pulled events can only come from the registry-resolved source.
  const deadFallback = buildTraceSource({ kind: "mlflow", endpoint: "http://127.0.0.1:59998" });
  const traceSourceFor = async (tenant, harnessId) => {
    const cfg = await sources.resolve(tenant, harnessId);
    return cfg ? buildTraceSource(cfg) : undefined;
  };
  const backend = new ServiceTopologyBackend({
    runtime,
    traceSource: deadFallback,
    traceSourceFor,
    specFor: () => spec,
    submit: async () => {}, // the agent already ran on the dev cluster and emitted to MLflow — we test the PULL
    graders: [stepsGrader, costGrader],
    newRunId: () => runId,
  });

  const evalCase = {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "report the code",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };

  // A) selection → the dispatch pulls the tagged trace from the registered source and scores it.
  console.log("\n=== A: selected source → pull-after-run + grade ===");
  const a = await backend.dispatch({ tenant: WS, harness: { id: HARNESS_ID, version: "1.0.0" }, runId, evalCase });
  const llm = a.trace.find((e) => e.kind === "llm_call");
  assert(
    a.trace.some((e) => e.kind === "tool_call"),
    "A pulled the agent's action steps from the registered source (tool_call present)",
  );
  assert(
    llm?.model === "gpt-5.4-mini" && llm?.cost?.inputTokens === 42,
    "A real MLflow span pulled via TAG correlation (llm_call 42/7)",
  );
  const steps = a.scores.find((s) => s.graderId === "steps");
  const cost = a.scores.find((s) => s.graderId === "cost");
  assert((steps?.value ?? 0) > 0, `A steps grader scored the pulled trace (${steps?.value})`);
  assert(Math.abs((cost?.value ?? 0) - 0.01) < 1e-9, `A cost grader scored the pulled llm_call cost (${cost?.value})`);

  // B) no selection → fall back to the fixed (dead) source → no pulled events (proves the SELECTION is what drives the pull).
  console.log("\n=== B: no selection → fallback (proves selection drives the pull) ===");
  await sources.assign(WS, HARNESS_ID, null); // clear the assignment
  const b = await backend.dispatch({ tenant: WS, harness: { id: HARNESS_ID, version: "1.0.0" }, runId, evalCase });
  assert(!b.trace.some((e) => e.kind === "llm_call"), "B no llm_call pulled (fell back to the dead fixed source)");
  assert(
    b.trace.some((e) => e.kind === "error"),
    "B the fallback pull failure is surfaced as an error event (non-fatal)",
  );

  console.log(
    "\n\x1b[32m✅ trace-source registry live e2e PASS — a workspace-registered MLflow source, selected per-harness, drives the service-topology pull-after-run (tag correlation) and grading; clearing the selection falls back. eval-through-the-registry.\x1b[0m",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker cleanup done)");
    } catch {}
  }
}
