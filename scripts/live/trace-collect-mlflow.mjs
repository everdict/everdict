// live e2e: verify 2-phase trace collection (D4) against *real MLflow 3.14* — docs/architecture/streaming-case-pipeline.md
//   S1 collect="job":          runCase releases compute, then collectTrace(runId) pulls from real MLflow —
//                              confirms the round-trip where the same runId flows through both the command env (EVERDICT_RUN_ID) and the pull.
//   S2 collect="control-plane": the job (runCase) carries only traceRef and ends at run → executeCase completes the result via a real MLflow pull +
//                              deferred observation scoring (steps/cost).
//   S3 soft-degrade:           dead endpoint → error event surfaced + the job's ground-truth score preserved.
//
// Correlation note: real MLflow mints the trace id server-side (everdict cannot set it), so runId is injected
// as the platform trace id (same convention as pull-ingest's runs[{caseId,runId}]). The "trace written by an
// instrumented agent" is seeded via MlflowTraceSink (create + OTLP spans, ≥3.12) — a path already verified in the sink e2e (trace-sink-mlflow.mjs).
// Tag (everdict.run_id) search correlation is a follow-up in the design doc.
//
// Prereq: docker (the script boots/cleans up ghcr.io/mlflow/mlflow:v3.14.0). To use an existing server, set MLFLOW_ENDPOINT.
// Usage: node scripts/live/trace-collect-mlflow.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeCase } from "../../apps/api/dist/execute-case.js";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { CommandHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";
import { buildTraceSink, buildTraceSource } from "../../packages/trace/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTAINER = "everdict-trace-collect-e2e";
let bootedDocker = false;
let ENDPOINT = process.env.MLFLOW_ENDPOINT ?? "";

async function up(url) {
  try {
    return (await fetch(`${url}/version`)).ok;
  } catch {
    return false;
  }
}

// 0) MLflow setup — if MLFLOW_ENDPOINT is unset, boot v3.14.0 via docker (OTLP span upload requires ≥3.12).
if (!ENDPOINT) {
  ENDPOINT = "http://127.0.0.1:5507";
  console.log(`MLflow boot (docker, v3.14.0) → ${ENDPOINT}`);
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "5507:5000",
    "ghcr.io/mlflow/mlflow:v3.14.0",
    "mlflow",
    "server",
    "--host",
    "0.0.0.0",
    "--port",
    "5000",
    "--backend-store-uri",
    "sqlite:////tmp/mlflow.db",
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

function assert(cond, label) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

try {
  // 1) Seed — 2 "traces written by an instrumented agent to the platform" (for S1/S2). Spans carry llm/tool (≥3.12).
  const { experiment_id: experimentId } = await api("/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name: `everdict-trace-collect-e2e-${Date.now()}` }),
  });
  const sink = buildTraceSink({ kind: "mlflow", endpoint: ENDPOINT, project: experimentId });
  const seedTrace = [
    { t: 0, kind: "message", role: "user", text: "task instruction" },
    {
      t: 10,
      kind: "llm_call",
      model: "gpt-5.4-mini",
      cost: { inputTokens: 42, outputTokens: 7, usd: 0.01 },
      latencyMs: 5,
    },
    { t: 20, kind: "tool_call", id: "t1", name: "bash", args: {} },
    { t: 30, kind: "tool_result", id: "t1", ok: true, output: "done" },
  ];
  const seeded = await sink.export({ scorecardId: "sc-e2e", dataset: "d@1", harness: "h@1" }, [
    { caseId: "seed-job", trace: seedTrace, scores: [] },
    { caseId: "seed-cp", trace: seedTrace, scores: [] },
    { caseId: "seed-tag", trace: seedTrace, scores: [] },
  ]);
  for (const c of seeded.cases) if (c.error) throw new Error(`seed failed (${c.caseId}): ${c.error}`);
  const [tidJob, tidCp, tidTag] = seeded.cases.map((c) => c.externalId);
  console.log(`seeded traces: job=${tidJob} cp=${tidCp} tag=${tidTag}`);
  // Poll until spans are readable (absorb the lag right after upload).
  const source = buildTraceSource({ kind: "mlflow", endpoint: ENDPOINT });
  let seedEvents = [];
  for (let i = 0; i < 15 && seedEvents.length === 0; i++) {
    await sleep(1000);
    seedEvents = await source.fetch(tidJob).catch(() => []);
  }
  assert(
    seedEvents.some((e) => e.kind === "llm_call"),
    `seed spans ready for round-trip (llm_call ${seedEvents.length} events)`,
  );

  // Shared — declarative command harness (mimics an instrumented CLI: writes the injected EVERDICT_RUN_ID as a marker) + case.
  const specFor = (collect) => ({
    kind: "command",
    id: "instrumented-cli",
    version: "1.0.0",
    setup: [],
    command: "sh -c 'echo \"run_id=$EVERDICT_RUN_ID\" > marker.txt'",
    env: {},
    params: {},
    trace: { kind: "mlflow", endpoint: ENDPOINT, collect },
  });
  const graderSpecs = [{ id: "tests-pass", config: { cmd: "test -f marker.txt" } }, { id: "steps" }, { id: "cost" }];
  const caseFor = (id) => ({
    id,
    env: { kind: "repo", source: { files: { "README.md": "seed\n" } } },
    task: "leave a marker",
    graders: graderSpecs,
    timeoutSec: 120,
    tags: [],
  });
  const depsFor = (collect, runId) => ({
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new CommandHarness(specFor(collect)),
    graders: makeGraders(graderSpecs),
    runCtx: { apiKeyEnv: {}, timeoutSec: 120, runId },
  });
  const score = (r, id) => r.scores.find((s) => s.graderId === id);

  // 2) S1 — collect="job": run (marker) → release compute → collectTrace(runId) pulls from real MLflow → observation scoring.
  console.log("\n=== S1: collect=job — in-job pull round-trip after release ===");
  const r1 = await runCase(caseFor("c-job"), depsFor("job", tidJob));
  assert(
    r1.snapshot.diff.includes(`run_id=${tidJob}`),
    "S1 correlation key round-trip — the EVERDICT_RUN_ID the command saw = the runId used for the pull",
  );
  const llm1 = r1.trace.find((e) => e.kind === "llm_call");
  assert(
    llm1?.model === "gpt-5.4-mini" && llm1?.cost?.inputTokens === 42,
    "S1 real MLflow span collected into the trace (llm_call 42/7)",
  );
  assert(score(r1, "tests-pass")?.pass === true, "S1 ground-truth (tests-pass) PASS");
  assert((score(r1, "steps")?.value ?? 0) > 0, "S1 steps derived from the collected trace");
  assert(
    Math.abs((score(r1, "cost")?.value ?? 0) - 0.01) < 1e-9,
    "S1 cost derived from the collected llm_call cost (0.01)",
  );
  assert(r1.traceRef === undefined, "S1 no traceRef (in-job collection — nothing deferred)");

  // 3) S2 — collect="control-plane": the job carries only traceRef → executeCase completes it via pull + deferred observation scoring.
  console.log("\n=== S2: collect=control-plane — completed via out-of-job collection ===");
  const pre = await runCase(caseFor("c-cp"), depsFor("control-plane", tidCp));
  assert(
    pre.traceRef?.kind === "mlflow" && pre.traceRef?.runId === tidCp,
    "S2 job result carries traceRef (kind/endpoint/runId)",
  );
  assert(!pre.trace.some((e) => e.kind === "llm_call"), "S2 no pull inside the job (execution events only)");
  assert(
    pre.scores.map((s) => s.graderId).join(",") === "tests-pass",
    "S2 the job scores only ground-truth (observation scoring deferred)",
  );
  const job = { evalCase: caseFor("c-cp"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const done = await executeCase({ dispatcher: { dispatch: async () => pre }, buildTraceSource }, "e2e", job);
  const llm2 = done.trace.find((e) => e.kind === "llm_call");
  assert(llm2?.model === "gpt-5.4-mini", "S2 executeCase pulls from real MLflow to complete the trace");
  assert((score(done, "steps")?.value ?? 0) > 0, "S2 deferred steps scored on the control plane");
  assert(Math.abs((score(done, "cost")?.value ?? 0) - 0.01) < 1e-9, "S2 deferred cost scored (0.01)");
  assert(
    score(done, "tests-pass")?.pass === true,
    "S2 the job's ground-truth score preserved (no double scoring: one tests-pass)",
  );
  assert(done.scores.filter((s) => s.graderId === "tests-pass").length === 1, "S2 exactly one tests-pass");

  // 4) S3 — soft-degrade: dead endpoint → error event surfaced + execution artifacts preserved (the case does not die).
  console.log("\n=== S3: soft-degrade — a collection failure does not discard execution artifacts ===");
  const broken = { ...pre, traceRef: { ...pre.traceRef, endpoint: "http://127.0.0.1:59999" } };
  const degraded = await executeCase({ dispatcher: { dispatch: async () => broken }, buildTraceSource }, "e2e", job);
  assert(
    degraded.trace.some((e) => e.kind === "error" && e.message.includes("trace collection failed")),
    "S3 collection failure surfaced as an error event",
  );
  assert(score(degraded, "tests-pass")?.pass === true, "S3 ground-truth score preserved (soft-degrade)");

  // 5) S4 — correlate="tag": real instrumented-agent convention. The agent leaves only an everdict.run_id tag on its own trace
  //    (real SDK's set_trace_tag = PATCH /traces/{id}/tags), and everdict correlates by tag search using the runId it minted (not the
  //    trace id!) — verifies that collection works against real MLflow without the runId=trace_id convention.
  console.log("\n=== S4: correlate=tag — everdict.run_id tag search correlation (out-of-job collection) ===");
  const tagRunId = `everdict-e2e-${Date.now().toString(36)}`;
  await api(`/api/3.0/mlflow/traces/${tidTag}/tags`, {
    method: "PATCH",
    body: JSON.stringify({ key: "everdict.run_id", value: tagRunId }),
  });
  const specTag = {
    ...specFor("control-plane"),
    trace: {
      kind: "mlflow",
      endpoint: ENDPOINT,
      collect: "control-plane",
      correlate: "tag",
      experiment: String(experimentId),
    },
  };
  const preTag = await runCase(caseFor("c-tag"), {
    ...depsFor("control-plane", tagRunId),
    harness: new CommandHarness(specTag),
  });
  assert(
    preTag.traceRef?.correlate === "tag" && preTag.traceRef?.experiment === String(experimentId),
    "S4 traceRef carries the tag correlation coordinates (correlate/experiment)",
  );
  assert(
    preTag.snapshot.diff.includes(`run_id=${tagRunId}`),
    "S4 the EVERDICT_RUN_ID the command saw = the tag value (agent contract)",
  );
  const jobTag = { evalCase: caseFor("c-tag"), harness: { id: "instrumented-cli", version: "1.0.0" }, tenant: "e2e" };
  const doneTag = await executeCase({ dispatcher: { dispatch: async () => preTag }, buildTraceSource }, "e2e", jobTag);
  const llmTag = doneTag.trace.find((e) => e.kind === "llm_call");
  assert(
    llmTag?.model === "gpt-5.4-mini",
    "S4 real span collected via tag search (correlation succeeds even though runId ≠ trace_id)",
  );
  assert((score(doneTag, "steps")?.value ?? 0) > 0, "S4 deferred observation scoring completed");

  console.log(
    "\n✅ trace-collect live e2e PASS — D4 verified against real MLflow 3.14: in-job pull round-trip after release (S1) · out-of-job collection completion (S2) · soft-degrade (S3) · everdict.run_id tag correlation (S4).",
  );
} finally {
  if (bootedDocker) {
    try {
      execFileSync("docker", ["stop", CONTAINER]);
      console.log("(docker cleanup done)");
    } catch {}
  }
}
